import 'dart:io';
import 'package:flutter/material.dart';
import 'package:webview_windows/webview_windows.dart';
import 'package:desktop_multi_window/desktop_multi_window.dart';

import '../../models/platform_model.dart';
import '../../common.dart';
import '../../main.dart';

class DesktopGlobalChatScreen extends StatefulWidget {
  const DesktopGlobalChatScreen({Key? key}) : super(key: key);

  @override
  State<DesktopGlobalChatScreen> createState() => _DesktopGlobalChatScreenState();
}

class _DesktopGlobalChatScreenState extends State<DesktopGlobalChatScreen> {
  final _controller = WebviewController();
  bool _isWebviewInitialized = false;
  bool _hasError = false;

  @override
  void initState() {
    super.initState();
    _initWebview();
  }

  Future<void> _initWebview() async {
    try {
      await _controller.initialize();
      // Replace this IP with the actual VPS IP
      final deviceId = bind.mainGetLocalOption(key: 'custom-id');
      await _controller.loadUrl('http://ad.apndocs.site:3000/?device_id=$deviceId');
      
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
          if (!_isWebviewInitialized && !_hasError)
            const Center(child: CircularProgressIndicator()),
          if (_hasError)
            const Center(child: Text('Failed to load chat. Please check your connection.', style: TextStyle(color: Colors.white))),
          
          // A tiny draggable area or close button at top right
          Positioned(
            top: 0,
            right: 0,
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white70, size: 20),
              onPressed: () {
                WindowController.fromWindowId(kWindowId!).close();
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
                WindowController.fromWindowId(kWindowId!).startDragging();
              },
            ),
          ),
        ],
      ),
    );
  }
}
