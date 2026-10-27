#include <ApplicationServices/ApplicationServices.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int find_window(pid_t target) {
  int window = 0;
  CFArrayRef windows =
      CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (!windows) return window;

  for (CFIndex index = 0; index < CFArrayGetCount(windows); index++) {
    CFDictionaryRef item = CFArrayGetValueAtIndex(windows, index);
    int owner = 0;
    int layer = 0;
    CFNumberGetValue(CFDictionaryGetValue(item, kCGWindowOwnerPID), kCFNumberIntType, &owner);
    CFNumberGetValue(CFDictionaryGetValue(item, kCGWindowLayer), kCFNumberIntType, &layer);
    if (owner == target && layer == 0) {
      CFNumberGetValue(CFDictionaryGetValue(item, kCGWindowNumber), kCFNumberIntType, &window);
      break;
    }
  }
  CFRelease(windows);
  return window;
}

int main(int argc, char** argv) {
  if (argc == 2 && strcmp(argv[1], "check-access") == 0) {
    printf("{\"postAccess\":%s}\n", CGPreflightPostEventAccess() ? "true" : "false");
    return 0;
  }
  if (argc < 5) return 2;

  pid_t target = (pid_t)atoi(argv[1]);
  CGPoint location = CGPointMake(atof(argv[2]), atof(argv[3]));
  int spoof = strcmp(argv[4], "zero") == 0;
  int keyboard = argc > 5 && strcmp(argv[5], "keyboard") == 0;
  int window = find_window(target);
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  if (!source) return 3;

  printf("{\"postAccess\":%s,\"window\":%d,\"spoof\":%s,\"sourcePIDs\":[",
         CGPreflightPostEventAccess() ? "true" : "false", window, spoof ? "true" : "false");
  for (int release = 0; release < 2; release++) {
    CGEventRef event = keyboard
                           ? CGEventCreateKeyboardEvent(source, 36, release == 0)
                           : CGEventCreateMouseEvent(source, release == 0 ? kCGEventLeftMouseDown
                                                                         : kCGEventLeftMouseUp,
                                                     location, kCGMouseButtonLeft);
    if (!event) {
      CFRelease(source);
      return 4;
    }
    CGEventSetLocation(event, location);
    if (!keyboard) {
      CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
      CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, window);
      CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                                  window);
    }
    if (spoof) CGEventSetIntegerValueField(event, kCGEventSourceUnixProcessID, 0);
    printf("%s%lld", release == 0 ? "" : ",",
           (long long)CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID));
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    if (release == 0) usleep(30000);
  }
  puts("]}");
  CFRelease(source);
  return 0;
}
