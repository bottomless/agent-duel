#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <memory>
#include <string>
#include <mutex>

namespace {
std::mutex clickMutex;
napi_threadsafe_function clickHandler = nullptr;
void emitClick(NSString* payload) {
  auto text = std::make_unique<std::string>(payload.UTF8String ?: "{}");
  std::lock_guard<std::mutex> lock(clickMutex);
  if (clickHandler && napi_call_threadsafe_function(clickHandler, text.get(), napi_tsfn_nonblocking) == napi_ok) text.release();
}
}

@interface ArenaNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation ArenaNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
      willPresentNotification:(UNNotification*)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
 didReceiveNotificationResponse:(UNNotificationResponse*)response
        withCompletionHandler:(void (^)(void))completion {
  if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
    NSString* payload = response.notification.request.content.userInfo[@"arenaRoute"];
    if ([payload isKindOfClass:NSString.class]) emitClick(payload);
  }
  completion();
}
@end

namespace {
ArenaNotificationDelegate* centerDelegate;
const char* permissionName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

struct Reply {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  std::string permission = "unknown";
  bool failed = false;
};
struct Work {
  napi_async_work work;
  napi_deferred deferred;
  bool request = false;
  bool send = false;
  bool silent = false;
  std::string title, body, route;
  std::string permission = "unknown";
  std::string error;
};

void execute(napi_env, void* data) {
  auto* work = static_cast<Work*>(data);
  auto reply = std::make_shared<Reply>();
  const bool request = work->request;
  const bool send = work->send, silent = work->silent;
  NSString* title = @(work->title.c_str());
  NSString* body = @(work->body.c_str());
  NSString* route = @(work->route.c_str());
  // Cocoa work belongs to Electron's main queue. Waiting uses a libuv worker,
  // never the JavaScript/UI thread. Late replies retain only their own state.
  dispatch_async(dispatch_get_main_queue(), ^{
    @try {
      if (!NSBundle.mainBundle.bundleIdentifier) {
        reply->failed = true;
        dispatch_semaphore_signal(reply->done);
        return;
      }
      UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
      void (^readSettings)(void) = ^{
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
          reply->permission = permissionName(settings.authorizationStatus);
          dispatch_semaphore_signal(reply->done);
        }];
      };
      if (send) {
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
          if (settings.authorizationStatus != UNAuthorizationStatusAuthorized && settings.authorizationStatus != UNAuthorizationStatusProvisional) {
            reply->failed = true;
            dispatch_semaphore_signal(reply->done);
            return;
          }
          UNMutableNotificationContent* content = [UNMutableNotificationContent new];
          content.title = title;
          content.body = body;
          content.userInfo = @{@"arenaRoute": route};
          if (!silent) content.sound = UNNotificationSound.defaultSound;
          UNNotificationRequest* notification = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
          [center addNotificationRequest:notification withCompletionHandler:^(NSError* error) {
            reply->failed = error != nil;
            dispatch_semaphore_signal(reply->done);
          }];
        }];
      } else if (request) {
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
          completionHandler:^(BOOL, NSError* error) {
            if (error) {
              reply->failed = true;
              dispatch_semaphore_signal(reply->done);
            } else {
              readSettings();
            }
          }];
      } else {
        readSettings();
      }
    } @catch (NSException*) {
      reply->failed = true;
      dispatch_semaphore_signal(reply->done);
    }
  });
  const auto timeout = dispatch_time(DISPATCH_TIME_NOW, (request ? 60LL : 5LL) * NSEC_PER_SEC);
  if (dispatch_semaphore_wait(reply->done, timeout) != 0) {
    work->error = "macOS notification operation timed out";
  } else if (reply->failed) {
    work->error = send ? "macOS did not accept the notification" : "Unable to read notification permission";
  } else {
    work->permission = reply->permission;
  }
}

void complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Work> work(static_cast<Work*>(data));
  napi_value value;
  if (status != napi_ok || !work->error.empty()) {
    const char* message = work->error.empty() ? "Notification permission query cancelled" : work->error.c_str();
    napi_value text;
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
    napi_create_error(env, nullptr, text, &value);
    napi_reject_deferred(env, work->deferred, value);
  } else {
    if (work->send) napi_get_undefined(env, &value);
    else napi_create_string_utf8(env, work->permission.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, work->deferred, value);
  }
  napi_delete_async_work(env, work->work);
}

napi_value queueWork(napi_env env, std::unique_ptr<Work> work) {
  napi_value promise, name;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "notification permission", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, execute, complete, work.get(), &work->work) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to create notification permission query");
    return nullptr;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work);
    napi_throw_error(env, nullptr, "Unable to queue notification permission query");
    return nullptr;
  }
  work.release();
  return promise;
}

napi_value query(napi_env env, napi_callback_info info) {
  void* callbackData;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &callbackData);
  auto work = std::make_unique<Work>();
  work->request = callbackData != nullptr;
  return queueWork(env, std::move(work));
}

bool readString(napi_env env, napi_value value, std::string& result) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  result.resize(length);
  return napi_get_value_string_utf8(env, value, result.data(), length + 1, &length) == napi_ok;
}

napi_value sendNotification(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto work = std::make_unique<Work>();
  work->send = true;
  if (argc != 4 || !readString(env, args[0], work->title) || !readString(env, args[1], work->body) ||
      !readString(env, args[2], work->route) || napi_get_value_bool(env, args[3], &work->silent) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected notification title, body, route and silent flag");
    return nullptr;
  }
  return queueWork(env, std::move(work));
}

void callClick(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<std::string> payload(static_cast<std::string*>(data));
  if (!env || !callback) return;
  napi_value argument, receiver, result;
  napi_create_string_utf8(env, payload->c_str(), NAPI_AUTO_LENGTH, &argument);
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, &argument, &result);
}
void cleanupClick(void*) {
  std::lock_guard<std::mutex> lock(clickMutex);
  if (clickHandler) napi_release_threadsafe_function(clickHandler, napi_tsfn_abort);
  clickHandler = nullptr;
}
napi_value setClickHandler(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value callback, name;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  napi_create_string_utf8(env, "notification click", NAPI_AUTO_LENGTH, &name);
  {
    std::lock_guard<std::mutex> lock(clickMutex);
    if (clickHandler) {
      napi_throw_error(env, nullptr, "Notification click handler already registered");
      return nullptr;
    }
    if (napi_create_threadsafe_function(env, callback, nullptr, name, 0, 1, nullptr, nullptr, nullptr, callClick, &clickHandler) != napi_ok) {
      napi_throw_error(env, nullptr, "Unable to register notification click handler");
      return nullptr;
    }
    napi_unref_threadsafe_function(env, clickHandler);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    centerDelegate = [ArenaNotificationDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = centerDelegate;
  });
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  static int requestMarker;
  napi_add_env_cleanup_hook(env, cleanupClick, nullptr);
  napi_property_descriptor methods[] = {
    {"send", nullptr, sendNotification, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setClickHandler", nullptr, setClickHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getPermission", nullptr, query, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestPermission", nullptr, query, nullptr, nullptr, nullptr, napi_default, &requestMarker},
  };
  napi_define_properties(env, exports, 4, methods);
  return exports;
}
}
NAPI_MODULE(notification_permissions, init)
