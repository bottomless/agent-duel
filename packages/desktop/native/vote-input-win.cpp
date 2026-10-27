#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif

#include <windows.h>
#include <commctrl.h>

#include <delayimp.h>

#include <node_api.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iterator>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kMaxEvents = 32;
constexpr auto kEventLifetime = std::chrono::seconds(2);
constexpr double kPointerTolerance = 2.0;
// SDKs can omit IMDT_TOUCHPAD although Windows returns its documented device value.
constexpr unsigned int kTouchpadDevice = 0x10;

enum class EventKind { Pointer, Keyboard };

struct MessageIdentity {
  HWND rootWindow = nullptr;
  EventKind kind = EventKind::Pointer;
  UINT virtualKey = 0;
  LONG messageTime = 0;
  LONG screenX = 0;
  LONG screenY = 0;
  Clock::time_point receivedAt;
};

struct NativeEvent {
  EventKind kind;
  HWND rootWindow = nullptr;
  double screenX = 0;
  double screenY = 0;
  UINT virtualKey = 0;
  bool sourceKnown = false;
  INPUT_MESSAGE_DEVICE_TYPE deviceType = IMDT_UNAVAILABLE;
  INPUT_MESSAGE_ORIGIN_ID originId = IMO_UNAVAILABLE;
  Clock::time_point receivedAt;
};

std::mutex eventMutex;
std::deque<NativeEvent> events;
std::deque<MessageIdentity> seenMessages;
std::set<HWND> subclassedWindows;
HHOOK messageHook = nullptr;
constexpr UINT_PTR kSubclassId = 0x4144564c;

bool sameIdentity(const MessageIdentity& left, const MessageIdentity& right) {
  return left.rootWindow == right.rootWindow && left.kind == right.kind &&
         left.virtualKey == right.virtualKey && left.messageTime == right.messageTime &&
         left.screenX == right.screenX && left.screenY == right.screenY;
}

void pruneExpired(Clock::time_point now) {
  while (!events.empty() && now - events.front().receivedAt > kEventLifetime) {
    events.pop_front();
  }
  while (!seenMessages.empty() && now - seenMessages.front().receivedAt > kEventLifetime) {
    seenMessages.pop_front();
  }
}

bool isSupportedMessage(UINT message, WPARAM wParam, EventKind& kind, UINT& virtualKey) {
  if (message == WM_LBUTTONUP) {
    kind = EventKind::Pointer;
    virtualKey = 0;
    return true;
  }
  if (message != WM_KEYUP && message != WM_SYSKEYUP) return false;

  const UINT key = static_cast<UINT>(wParam);
  if (key != VK_RETURN && key != VK_SPACE) return false;
  kind = EventKind::Keyboard;
  virtualKey = key;
  return true;
}

HWND rootWindowFor(HWND window) {
  if (!window) return nullptr;
  HWND root = GetAncestor(window, GA_ROOT);
  return root ? root : window;
}

void recordMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  EventKind kind;
  UINT virtualKey;
  if (!window || !isSupportedMessage(message, wParam, kind, virtualKey)) return;

  const Clock::time_point now = Clock::now();
  INPUT_MESSAGE_SOURCE source{};
  const bool sourceKnown = GetCurrentInputMessageSource(&source) != FALSE;

  NativeEvent record;
  record.kind = kind;
  record.rootWindow = rootWindowFor(window);
  record.virtualKey = virtualKey;
  record.sourceKnown = sourceKnown;
  if (sourceKnown) {
    record.deviceType = source.deviceType;
    record.originId = source.originId;
  }
  record.receivedAt = now;

  if (kind == EventKind::Pointer) {
    POINT screenPoint = {
        static_cast<LONG>(static_cast<SHORT>(LOWORD(lParam))),
        static_cast<LONG>(static_cast<SHORT>(HIWORD(lParam))),
    };
    if (!ClientToScreen(window, &screenPoint)) return;
    record.screenX = static_cast<double>(screenPoint.x);
    record.screenY = static_cast<double>(screenPoint.y);
  }

  MessageIdentity identity;
  identity.rootWindow = record.rootWindow;
  identity.kind = kind;
  identity.virtualKey = virtualKey;
  identity.messageTime = GetMessageTime();
  identity.screenX = static_cast<LONG>(std::lround(record.screenX));
  identity.screenY = static_cast<LONG>(std::lround(record.screenY));
  identity.receivedAt = now;

  std::lock_guard<std::mutex> lock(eventMutex);
  pruneExpired(now);
  for (const MessageIdentity& seen : seenMessages) {
    if (sameIdentity(seen, identity)) return;
  }
  if (seenMessages.size() == kMaxEvents) seenMessages.pop_front();
  seenMessages.push_back(identity);
  if (events.size() == kMaxEvents) events.pop_front();
  events.push_back(record);
}

LRESULT CALLBACK windowSubclassProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                    UINT_PTR subclassId, DWORD_PTR refData);

void registerWindow(HWND window) {
  if (!window || GetWindowThreadProcessId(window, nullptr) != GetCurrentThreadId()) return;

  std::lock_guard<std::mutex> lock(eventMutex);
  if (subclassedWindows.find(window) != subclassedWindows.end()) return;
  if (SetWindowSubclass(window, windowSubclassProc, kSubclassId, 0)) {
    subclassedWindows.insert(window);
  }
}

BOOL CALLBACK enumChildWindows(HWND window, LPARAM) {
  registerWindow(window);
  return TRUE;
}

void registerWindowTree(HWND rootWindow) {
  registerWindow(rootWindow);
  EnumChildWindows(rootWindow, enumChildWindows, 0);
}

BOOL CALLBACK enumThreadWindows(HWND window, LPARAM) {
  registerWindowTree(window);
  return TRUE;
}

LRESULT CALLBACK callWindowProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code >= 0 && lParam != 0) {
    const CWPSTRUCT& message = *reinterpret_cast<const CWPSTRUCT*>(lParam);
    if (message.message == WM_CREATE) registerWindowTree(message.hwnd);
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

LRESULT CALLBACK windowSubclassProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                    UINT_PTR subclassId, DWORD_PTR) {
  if (subclassId == kSubclassId) {
    if (message == WM_LBUTTONUP || message == WM_KEYUP || message == WM_SYSKEYUP) {
      recordMessage(window, message, wParam, lParam);
    }
    if (message == WM_NCDESTROY) {
      RemoveWindowSubclass(window, windowSubclassProc, kSubclassId);
      std::lock_guard<std::mutex> lock(eventMutex);
      subclassedWindows.erase(window);
    }
  }
  return DefSubclassProc(window, message, wParam, lParam);
}

void cleanup(void*) {
  HHOOK hook;
  std::vector<HWND> windows;
  {
    std::lock_guard<std::mutex> lock(eventMutex);
    hook = messageHook;
    messageHook = nullptr;
    windows.assign(subclassedWindows.begin(), subclassedWindows.end());
    subclassedWindows.clear();
    events.clear();
    seenMessages.clear();
  }
  if (hook) UnhookWindowsHookEx(hook);
  for (HWND window : windows) RemoveWindowSubclass(window, windowSubclassProc, kSubclassId);
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

const char* originName(const NativeEvent& event) {
  if (!event.sourceKnown) return "unavailable";
  switch (event.originId) {
    case IMO_HARDWARE:
      return "hardware";
    case IMO_INJECTED:
      return "injected";
    case IMO_SYSTEM:
      return "system";
    case IMO_UNAVAILABLE:
    default:
      return "unavailable";
  }
}

const char* deviceName(const NativeEvent& event) {
  if (!event.sourceKnown) return "unavailable";
  if (static_cast<unsigned int>(event.deviceType) == kTouchpadDevice) return "touchpad";
  switch (event.deviceType) {
    case IMDT_UNAVAILABLE:
      return "unavailable";
    case IMDT_KEYBOARD:
      return "keyboard";
    case IMDT_MOUSE:
      return "mouse";
    case IMDT_TOUCH:
      return "touch";
    case IMDT_PEN:
      return "pen";
    default:
      return "other";
  }
}

void setString(napi_env env, napi_value object, const char* name, const char* value) {
  napi_value string;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &string);
  napi_set_named_property(env, object, name, string);
}

// Reports what Windows said about the matched message. The reveal decides what the facts mean.
napi_value activationValue(napi_env env, const NativeEvent& requested, const NativeEvent* match,
                           Clock::time_point now) {
  napi_value activation;
  napi_create_object(env, &activation);
  if (!match) {
    setString(env, activation, "status", "unmatched");
    return activation;
  }
  setString(env, activation, "status", "matched");
  napi_value elapsed;
  napi_create_int64(env, std::chrono::duration_cast<std::chrono::milliseconds>(now - match->receivedAt).count(),
                    &elapsed);
  napi_set_named_property(env, activation, "elapsedMs", elapsed);
  napi_value distance;
  if (requested.kind == EventKind::Pointer) {
    napi_create_double(env,
                       std::max(std::abs(match->screenX - requested.screenX), std::abs(match->screenY - requested.screenY)),
                       &distance);
  } else {
    napi_get_null(env, &distance);
  }
  napi_set_named_property(env, activation, "distance", distance);
  napi_value event;
  napi_create_object(env, &event);
  setString(env, event, "platform", "win32");
  setString(env, event, "origin", originName(*match));
  setString(env, event, "device", deviceName(*match));
  napi_set_named_property(env, activation, "event", event);
  return activation;
}

napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr) != napi_ok || argc != 0) {
    napi_throw_type_error(env, nullptr, "start expects no arguments");
    return nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(eventMutex);
    if (!messageHook) {
      messageHook = SetWindowsHookExW(WH_CALLWNDPROC, callWindowProc, nullptr, GetCurrentThreadId());
      if (!messageHook) {
        napi_throw_error(env, nullptr, "unable to observe the Electron UI thread");
        return nullptr;
      }
    }
  }
  EnumThreadWindows(GetCurrentThreadId(), enumThreadWindows, 0);
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
        !readFiniteNumber(env, xValue, requested.screenX) ||
        !readFiniteNumber(env, yValue, requested.screenY)) {
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
    requested.virtualKey = key == "Enter" ? VK_RETURN : VK_SPACE;
  } else {
    napi_throw_type_error(env, nullptr, "input kind must be pointer or keyboard");
    return nullptr;
  }

  HWND window = *reinterpret_cast<HWND*>(bufferData);
  if (!window) {
    napi_throw_type_error(env, nullptr, "window handle contains a null window");
    return nullptr;
  }
  const HWND rootWindow = rootWindowFor(window);

  const Clock::time_point now = Clock::now();
  NativeEvent match;
  bool matched = false;
  {
    std::lock_guard<std::mutex> lock(eventMutex);
    pruneExpired(now);
    for (auto iterator = events.rbegin(); iterator != events.rend(); ++iterator) {
      const NativeEvent& event = *iterator;
      if (event.rootWindow != rootWindow || event.kind != requested.kind) continue;
      if (requested.kind == EventKind::Pointer) {
        if (std::abs(event.screenX - requested.screenX) > kPointerTolerance ||
            std::abs(event.screenY - requested.screenY) > kPointerTolerance) {
          continue;
        }
      } else if (event.virtualKey != requested.virtualKey) {
        continue;
      }
      match = event;
      matched = true;
      events.erase(std::next(iterator).base());
      break;
    }
  }

  return activationValue(env, requested, matched ? &match : nullptr, now);
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

// Electron exports Node-API through electron.exe. Delay-load node.exe and redirect that
// dependency to the current executable, matching node-gyp's Windows Electron hook.
static FARPROC WINAPI loadExeHook(unsigned notification, PDelayLoadInfo delayLoadInfo) {
  if (notification == dliNotePreLoadLibrary && delayLoadInfo && delayLoadInfo->szDll &&
      (_stricmp(delayLoadInfo->szDll, "node.exe") == 0 ||
       _stricmp(delayLoadInfo->szDll, "node.dll") == 0)) {
    HMODULE module = GetModuleHandleW(nullptr);
    return reinterpret_cast<FARPROC>(module);
  }
  return nullptr;
}

extern "C" decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = loadExeHook;

NAPI_MODULE(vote_input, init)
