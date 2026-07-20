import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_windows/webview_windows.dart';
import 'package:desktop_multi_window/desktop_multi_window.dart';
import 'package:uuid/uuid.dart';
import 'package:path_provider/path_provider.dart';

import '../../models/platform_model.dart';
import '../../main.dart';

class DesktopGlobalChatScreen extends StatefulWidget {
  const DesktopGlobalChatScreen({Key? key}) : super(key: key);

  @override
  State<DesktopGlobalChatScreen> createState() =>
      _DesktopGlobalChatScreenState();
}

class _DesktopGlobalChatScreenState extends State<DesktopGlobalChatScreen>
    with MultiWindowListener {
  final _controller = WebviewController();
  bool _isWebviewInitialized = false;
  bool _hasError = false;
  bool _isClosing = false;
  StreamSubscription<dynamic>? _webMessageSubscription;

  @override
  void initState() {
    super.initState();
    DesktopMultiWindow.addListener(this);
    _initWebview();
  }

  Future<void> _closeWindow() async {
    if (_isClosing) return;
    final windowId = kWindowId;
    if (windowId == null) return;
    _isClosing = true;
    final controller = WindowController.fromWindowId(windowId);
    try {
      await controller.setPreventClose(false);
      await controller.close();
    } catch (error, stackTrace) {
      _isClosing = false;
      debugPrint('Failed to close Global Chat: $error\n$stackTrace');
    }
  }

  @override
  void onWindowClose() {
    _closeWindow();
    super.onWindowClose();
  }

  Future<void> _initWebview() async {
    try {
      final supportDir = await getApplicationSupportDirectory();
      final userDataPath = '${supportDir.path}\\rustdesk_webview';
      await WebviewController.initializeEnvironment(userDataPath: userDataPath);
      await _controller.initialize();
      _webMessageSubscription = _controller.webMessage.listen((message) {
        if (message == 'close-chat') _closeWindow();
      });
      final deviceId = await bind.mainGetMyId();
      var chatToken = bind.mainGetLocalOption(key: 'global-chat-token');
      if (chatToken.isEmpty) {
        chatToken = const Uuid().v4();
        await bind.mainSetLocalOption(
            key: 'global-chat-token', value: chatToken);
      }
      final apiServer = 'http://ad.apndocs.site:3000';
      final chatUrl = Uri.parse(apiServer).replace(
        path:
            '${Uri.parse(apiServer).path.replaceFirst(RegExp(r'/$'), '')}/chat.html',
        queryParameters: {'device_id': deviceId, 'token': chatToken},
      );
      await _controller.loadUrl(chatUrl.toString());

      if (!mounted) return;
      setState(() {
        _isWebviewInitialized = true;
      });
    } catch (e) {
      debugPrint("Webview initialization error: $e");
      if (mounted) {
        setState(() {
          _hasError = true;
        });
      }
    }
  }

  @override
  void dispose() {
    DesktopMultiWindow.removeListener(this);
    _webMessageSubscription?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.escape): _closeWindow,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: Stack(
            children: [
              if (_isWebviewInitialized) Webview(_controller),
              if (!_isWebviewInitialized && !_hasError)
                const Center(child: CircularProgressIndicator()),
              if (_hasError)
                const Center(
                  child: Text(
                    'Failed to load chat. Please check your connection.',
                    style: TextStyle(color: Colors.white),
                  ),
                ),
              Positioned(
                top: 0,
                right: 0,
                child: IconButton(
                  icon:
                      const Icon(Icons.close, color: Colors.white70, size: 20),
                  tooltip: 'Close (Esc)',
                  onPressed: _closeWindow,
                ),
              ),
              Positioned(
                top: 0,
                left: 0,
                right: 40,
                height: 30,
                child: GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onPanStart: (details) {
                    WindowController.fromWindowId(kWindowId!).startDragging();
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
