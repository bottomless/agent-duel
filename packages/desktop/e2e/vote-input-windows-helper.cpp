#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

bool parseWindow(const char* value, HWND& result) {
  if (!value || *value == '\0') return false;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(value, &end, 0);
  if (!end || *end != '\0' || parsed == 0) return false;
  result = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(parsed));
  return true;
}

bool sendInputPointer(LONG x, LONG y) {
  if (!SetCursorPos(x, y)) return false;
  INPUT inputs[2]{};
  inputs[0].type = INPUT_MOUSE;
  inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  inputs[1].type = INPUT_MOUSE;
  inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  return SendInput(2, inputs, sizeof(INPUT)) == 2;
}

bool sendInputEnter() {
  INPUT inputs[2]{};
  inputs[0].type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_RETURN;
  inputs[1].type = INPUT_KEYBOARD;
  inputs[1].ki.wVk = VK_RETURN;
  inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
  return SendInput(2, inputs, sizeof(INPUT)) == 2;
}

bool postPointer(HWND window, UINT message, LONG x, LONG y) {
  POINT point{x, y};
  if (!ScreenToClient(window, &point)) return false;
  const LPARAM coordinates = MAKELPARAM(static_cast<SHORT>(point.x), static_cast<SHORT>(point.y));
  return PostMessageW(window, message, message == WM_LBUTTONDOWN ? MK_LBUTTON : 0, coordinates) != FALSE;
}

bool postEnter(HWND window, UINT message) {
  return PostMessageW(window, message, VK_RETURN, 0) != FALSE;
}

bool sendMessagePointer(HWND window, UINT message, LONG x, LONG y) {
  POINT point{x, y};
  if (!ScreenToClient(window, &point)) return false;
  const LPARAM coordinates = MAKELPARAM(static_cast<SHORT>(point.x), static_cast<SHORT>(point.y));
  SendMessageW(window, message, message == WM_LBUTTONDOWN ? MK_LBUTTON : 0, coordinates);
  return true;
}

bool sendMessageEnter(HWND window, UINT message) {
  SendMessageW(window, message, VK_RETURN, 0);
  return true;
}

bool centerPoint(HWND window, POINT& point) {
  RECT client{};
  if (!GetClientRect(window, &client)) return false;
  point.x = (client.right - client.left) / 2;
  point.y = (client.bottom - client.top) / 2;
  return ClientToScreen(window, &point) != FALSE;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) return 2;

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  HWND window = nullptr;
  if (!parseWindow(argv[1], window)) return 3;
  const char* mode = argv[2];
  POINT screenPoint{};
  if ((std::strcmp(mode, "send-pointer") == 0 || std::strcmp(mode, "post-pointer") == 0 ||
       std::strcmp(mode, "send-message-pointer") == 0) &&
      !centerPoint(window, screenPoint)) {
    return 4;
  }
  bool success = false;
  if (std::strcmp(mode, "send-pointer") == 0) {
    SetForegroundWindow(window);
    Sleep(50);
    success = sendInputPointer(screenPoint.x, screenPoint.y);
  } else if (std::strcmp(mode, "send-enter") == 0) {
    SetForegroundWindow(window);
    Sleep(50);
    success = sendInputEnter();
  } else if (std::strcmp(mode, "post-pointer") == 0) {
    success = postPointer(window, WM_LBUTTONDOWN, screenPoint.x, screenPoint.y) &&
              postPointer(window, WM_LBUTTONUP, screenPoint.x, screenPoint.y);
  } else if (std::strcmp(mode, "post-enter") == 0) {
    success = postEnter(window, WM_KEYUP);
  } else if (std::strcmp(mode, "send-message-pointer") == 0) {
    success = sendMessagePointer(window, WM_LBUTTONDOWN, screenPoint.x, screenPoint.y) &&
              sendMessagePointer(window, WM_LBUTTONUP, screenPoint.x, screenPoint.y);
  } else if (std::strcmp(mode, "send-message-enter") == 0) {
    success = sendMessageEnter(window, WM_KEYUP);
  }

  if (!success) return 5;
  if (std::strcmp(mode, "send-pointer") == 0 || std::strcmp(mode, "post-pointer") == 0 ||
      std::strcmp(mode, "send-message-pointer") == 0) {
    std::printf("%ld %ld\n", screenPoint.x, screenPoint.y);
  }
  return 0;
}
