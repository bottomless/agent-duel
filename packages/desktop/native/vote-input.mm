#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <node_api.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <iterator>
#include <mutex>
#include <string>

namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kMaxEvents = 32;
constexpr size_t kMaxEventIdentities = 64;
constexpr auto kEventLifetime = std::chrono::seconds(2);
constexpr double kPointerTolerance = 2.0;

enum class EventKind { Pointer, Keyboard };

struct NativeEvent {
  EventKind kind;
  NSInteger windowNumber = 0;
  double screenX = 0;
  double screenY = 0;
  uint16_t keyCode = 0;
  bool cgEventAvailable = false;
  bool sourcePIDKnown = false;
  int64_t sourcePID = 0;
  Clock::time_point receivedAt;
};

struct NativeEventIdentity {
  const void* cgEvent = nullptr;
  NSTimeInterval timestamp = 0;
  Clock::time_point receivedAt;
};

std::mutex eventMutex;
std::deque<NativeEvent> events;
std::deque<NativeEventIdentity> recentIdentities;
id localMonitor = nil;

void pruneExpired(Clock::time_point now) {
  while (!events.empty() && now - events.front().receivedAt > kEventLifetime) {
    events.pop_front();
  }
  while (!recentIdentities.empty() && now - recentIdentities.front().receivedAt > kEventLifetime) {
    recentIdentities.pop_front();
  }
}

void recordEvent(NSEvent* event) {
  NativeEvent record;
  record.kind = event.type == NSEventTypeLeftMouseUp ? EventKind::Pointer : EventKind::Keyboard;
  record.windowNumber = event.windowNumber;
  record.receivedAt = Clock::now();
  if (record.kind == EventKind::Keyboard) {
    record.keyCode = event.keyCode;
    if (record.keyCode != 36 && record.keyCode != 49 && record.keyCode != 76) return;
  }

  CGEventRef cgEvent = event.CGEvent;
  record.cgEventAvailable = cgEvent != nullptr;
  if (cgEvent) {
    CGPoint location = CGEventGetLocation(cgEvent);
    record.screenX = location.x;
    record.screenY = location.y;
    record.sourcePIDKnown = true;
    record.sourcePID = CGEventGetIntegerValueField(cgEvent, kCGEventSourceUnixProcessID);
  }
  std::lock_guard<std::mutex> lock(eventMutex);
  pruneExpired(record.receivedAt);

  // AppKit can deliver the same OS activation to a local monitor twice. Keep
  // its identity separately from the consumable queue so consuming the first
  // delivery cannot make the duplicate look like a second activation.
  if (cgEvent) {
    const void* identity = reinterpret_cast<const void*>(cgEvent);
    for (const NativeEventIdentity& recent : recentIdentities) {
      if (recent.cgEvent == identity && recent.timestamp == event.timestamp) return;
    }
    if (recentIdentities.size() == kMaxEventIdentities) recentIdentities.pop_front();
    recentIdentities.push_back({identity, event.timestamp, record.receivedAt});
  }
  if (events.size() == kMaxEvents) events.pop_front();
  events.push_back(record);
}

void cleanup(void*) {
  id monitor;
  {
    std::lock_guard<std::mutex> lock(eventMutex);
    monitor = localMonitor;
    localMonitor = nil;
    events.clear();
    recentIdentities.clear();
  }
  if (monitor) [NSEvent removeMonitor:monitor];
}

bool readString(napi_env env, napi_value value, std::string& result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  result.resize(length);
  return napi_get_value_string_utf8(env, value, result.data(), length + 1, &length) == napi_ok;
}

bool readFiniteNumber(napi_env env, napi_value value, double& result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  return napi_get_value_double(env, value, &result) == napi_ok && std::isfinite(result);
}

bool getProperty(napi_env env, napi_value object, const char* name, napi_value& value) {
  return napi_get_named_property(env, object, name, &value) == napi_ok;
}

const char* sourceResult(const NativeEvent& event) {
  if (!event.cgEventAvailable) return "unknown";
  if (!event.sourcePIDKnown) return "unknown";
  if (event.sourcePID > 0) return "injected";
  if (event.sourcePID == 0) return "native";
  return "unknown";
}

napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr) != napi_ok || argc != 0) {
    napi_throw_type_error(env, nullptr, "start expects no arguments");
    return nullptr;
  }

  std::lock_guard<std::mutex> lock(eventMutex);
  if (!localMonitor) {
    localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseUp | NSEventMaskKeyUp)
                                                          handler:^NSEvent*(NSEvent* event) {
      recordEvent(event);
      return event;
    }];
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value consume(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2) {
    napi_throw_type_error(env, nullptr, "consume expects a window handle and input");
    return nullptr;
  }

  bool isBuffer = false;
  if (napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer) {
    napi_throw_type_error(env, nullptr, "window handle must be a Buffer");
    return nullptr;
  }
  void* bufferData = nullptr;
  size_t bufferLength = 0;
  if (napi_get_buffer_info(env, args[0], &bufferData, &bufferLength) != napi_ok ||
      !bufferData || bufferLength != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "window handle must contain one native pointer");
    return nullptr;
  }

  napi_valuetype inputType;
  if (napi_typeof(env, args[1], &inputType) != napi_ok || inputType != napi_object) {
    napi_throw_type_error(env, nullptr, "input must be an object");
    return nullptr;
  }
  napi_value kindValue;
  std::string kind;
  if (!getProperty(env, args[1], "kind", kindValue) || !readString(env, kindValue, kind)) {
    napi_throw_type_error(env, nullptr, "input kind must be a string");
    return nullptr;
  }

  NativeEvent requested;
  if (kind == "pointer") {
    requested.kind = EventKind::Pointer;
    napi_value xValue, yValue;
    if (!getProperty(env, args[1], "screenX", xValue) || !getProperty(env, args[1], "screenY", yValue) ||
        !readFiniteNumber(env, xValue, requested.screenX) || !readFiniteNumber(env, yValue, requested.screenY)) {
      napi_throw_type_error(env, nullptr, "pointer input needs finite screenX and screenY");
      return nullptr;
    }
  } else if (kind == "keyboard") {
    requested.kind = EventKind::Keyboard;
    napi_value keyValue;
    std::string key;
    if (!getProperty(env, args[1], "key", keyValue) || !readString(env, keyValue, key) ||
        (key != "Enter" && key != " " && key != "Spacebar")) {
      napi_throw_type_error(env, nullptr, "keyboard input key must be Enter, space, or Spacebar");
      return nullptr;
    }
    requested.keyCode = key == "Enter" ? 36 : 49;
    if (key == "Spacebar" || key == " ") requested.keyCode = 49;
  } else {
    napi_throw_type_error(env, nullptr, "input kind must be pointer or keyboard");
    return nullptr;
  }

  NSView* __unsafe_unretained view = *reinterpret_cast<NSView* __unsafe_unretained*>(bufferData);
  if (!view) {
    napi_throw_type_error(env, nullptr, "window handle contains a null view");
    return nullptr;
  }
  NSWindow* window = view.window;
  NSInteger windowNumber = window ? window.windowNumber : 0;

  const Clock::time_point now = Clock::now();
  const char* result = "unverified";
  {
    std::lock_guard<std::mutex> lock(eventMutex);
    pruneExpired(now);
    for (auto iterator = events.rbegin(); iterator != events.rend(); ++iterator) {
      const NativeEvent& event = *iterator;
      if (event.windowNumber != windowNumber || event.kind != requested.kind) continue;
      if (requested.kind == EventKind::Pointer) {
        if (!event.cgEventAvailable || std::abs(event.screenX - requested.screenX) > kPointerTolerance ||
            std::abs(event.screenY - requested.screenY) > kPointerTolerance) {
          continue;
        }
      } else {
        const bool matchesKey = event.keyCode == requested.keyCode ||
                                (requested.keyCode == 36 && event.keyCode == 76);
        if (!matchesKey) continue;
      }
      result = sourceResult(event);
      events.erase(std::next(iterator).base());
      break;
    }
  }

  napi_value output;
  napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &output);
  return output;
}

napi_value init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor methods[] = {
      {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"consume", nullptr, consume, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}

}  // namespace

NAPI_MODULE(vote_input, init)
