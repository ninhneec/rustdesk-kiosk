import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:window_manager/window_manager.dart';
import 'package:uuid/uuid.dart';
import 'package:http/http.dart' as http;

import '../../models/platform_model.dart';

class ChatMessage {
  final int id;
  final String senderId;
  final String body;
  final DateTime createdAt;

  ChatMessage({
    required this.id,
    required this.senderId,
    required this.body,
    required this.createdAt,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    return ChatMessage(
      id: json['id'] as int,
      senderId: json['sender_id'] as String,
      body: json['body'] as String,
      createdAt: DateTime.parse('${json['created_at']}Z'),
    );
  }
}

class DesktopGlobalChatScreen extends StatefulWidget {
  const DesktopGlobalChatScreen({Key? key}) : super(key: key);

  @override
  State<DesktopGlobalChatScreen> createState() =>
      _DesktopGlobalChatScreenState();
}

class _DesktopGlobalChatScreenState extends State<DesktopGlobalChatScreen>
    with WindowListener {
  bool _isLoading = true;
  String _errorMsg = '';

  String _deviceId = '';
  String _chatToken = '';
  String _channel = 'boss';
  final List<ChatMessage> _messages = [];
  final Map<String, int> _cursors = {'boss': 0, 'global': 0};
  final TextEditingController _inputController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  Timer? _pollTimer;
  bool _isSending = false;

  static const String _apiServer = 'http://ad.apndocs.site:3000';

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.setPreventClose(true);
    _initChat();
  }

  Future<void> _closeWindow() async {
    try {
      // Keep this independent process alive so the global hotkey can restore it.
      await windowManager.hide();
    } catch (error, stackTrace) {
      debugPrint('Failed to hide Global Chat: $error\n$stackTrace');
    }
  }

  @override
  void onWindowClose() {
    _closeWindow();
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'X-Device-Id': _deviceId,
        'X-Device-Token': _chatToken,
      };

  Future<void> _registerDevice(String hostname) async {
    try {
      final uri = Uri.parse('$_apiServer/api/device/save-password');
      await http.post(uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'id': _deviceId,
            'pass': '',
            'hostname': hostname,
            'chat_token': _chatToken,
          }));
      debugPrint('Device registered: $_deviceId ($hostname)');
    } catch (e) {
      debugPrint('Device registration error: $e');
    }
  }

  Future<void> _initChat() async {
    try {
      _deviceId = await bind.mainGetMyId();
      _chatToken = bind.mainGetLocalOption(key: 'global-chat-token');
      if (_chatToken.isEmpty || _chatToken.contains('-')) {
        _chatToken = const Uuid().v4().replaceAll('-', '');
        await bind.mainSetLocalOption(
            key: 'global-chat-token', value: _chatToken);
      }

      // Register device with server so chat_token is stored in DB
      await _registerDevice(Platform.localHostname);

      await _loadMessages(reset: true);

      if (!mounted) return;
      setState(() {
        _isLoading = false;
      });

      _pollTimer = Timer.periodic(
          const Duration(milliseconds: 2500), (_) => _loadMessages());
    } catch (e) {
      debugPrint('Chat init error: $e');
      if (mounted) {
        setState(() {
          _isLoading = false;
          _errorMsg = e.toString();
        });
      }
    }
  }

  Future<void> _loadMessages({bool reset = false}) async {
    if (reset) {
      _messages.clear();
      _cursors[_channel] = 0;
    }
    try {
      final uri = Uri.parse(
          '$_apiServer/api/chat/messages?channel=${Uri.encodeComponent(_channel)}&after_id=${_cursors[_channel] ?? 0}');
      final response = await http.get(uri, headers: _headers);
      if (response.statusCode != 200) {
        throw Exception('Server returned ${response.statusCode}');
      }
      final List<dynamic> data = jsonDecode(response.body);
      if (data.isEmpty) return;

      final newMessages =
          data.map((json) => ChatMessage.fromJson(json)).toList();

      if (!mounted) return;
      setState(() {
        for (final msg in newMessages) {
          if (msg.id > (_cursors[_channel] ?? 0)) {
            _cursors[_channel] = msg.id;
          }
          _messages.add(msg);
        }
        _errorMsg = '';
      });

      // Scroll to bottom after new messages
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController
              .animateTo(_scrollController.position.maxScrollExtent + 60,
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOut);
        }
      });
    } catch (e) {
      debugPrint('Load messages error: $e');
      // Don't overwrite UI on polling errors, just log
    }
  }

  Future<void> _sendMessage() async {
    final body = _inputController.text.trim();
    if (body.isEmpty || _isSending) return;

    setState(() => _isSending = true);
    try {
      final uri = Uri.parse('$_apiServer/api/chat/messages');
      final response = await http.post(uri,
          headers: _headers,
          body: jsonEncode({'channel': _channel, 'body': body}));
      if (response.statusCode == 200 || response.statusCode == 201) {
        _inputController.clear();
        await _loadMessages();
      }
    } catch (e) {
      debugPrint('Send message error: $e');
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  void _switchChannel(String channel) {
    if (channel == _channel) return;
    setState(() {
      _channel = channel;
      _isLoading = true;
    });
    _loadMessages(reset: true).then((_) {
      if (mounted) setState(() => _isLoading = false);
    });
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    _pollTimer?.cancel();
    _inputController.dispose();
    _scrollController.dispose();
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
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark().copyWith(
            scaffoldBackgroundColor: const Color(0xFF1a1a2e),
            colorScheme: const ColorScheme.dark(
              primary: Color(0xFF4a9eff),
              secondary: Color(0xFF6c63ff),
              surface: Color(0xFF16213e),
            ),
          ),
          home: Scaffold(
            backgroundColor: const Color(0xFF1a1a2e),
            body: Column(
              children: [
                // Header with drag area
                _buildHeader(),
                // Messages area
                Expanded(child: _buildMessageArea()),
                // Composer
                _buildComposer(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return GestureDetector(
      onPanStart: (_) {
        windowManager.startDragging();
      },
      child: Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: const BoxDecoration(
          color: Color(0xFF16213e),
          border: Border(
              bottom: BorderSide(color: Color(0xFF2a2a4a), width: 1)),
        ),
        child: Row(
          children: [
            const Icon(Icons.chat_bubble_outline,
                color: Color(0xFF4a9eff), size: 18),
            const SizedBox(width: 8),
            const Text('Hỗ trợ',
                style: TextStyle(
                    color: Colors.white,
                    fontSize: 14,
                    fontWeight: FontWeight.w600)),
            const Spacer(),
            // Channel selector
            Container(
              height: 30,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                color: const Color(0xFF1a1a2e),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: const Color(0xFF2a2a4a)),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _channel,
                  dropdownColor: const Color(0xFF16213e),
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                  icon: const Icon(Icons.arrow_drop_down,
                      color: Colors.white54, size: 16),
                  items: const [
                    DropdownMenuItem(
                        value: 'boss', child: Text('Nhắn boss')),
                    DropdownMenuItem(
                        value: 'global', child: Text('Kênh chung')),
                  ],
                  onChanged: (v) {
                    if (v != null) _switchChannel(v);
                  },
                ),
              ),
            ),
            const SizedBox(width: 8),
            // Close button
            InkWell(
              onTap: _closeWindow,
              borderRadius: BorderRadius.circular(4),
              child: const Padding(
                padding: EdgeInsets.all(4),
                child:
                    Icon(Icons.close, color: Colors.white54, size: 18),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageArea() {
    if (_isLoading && _messages.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(color: Color(0xFF4a9eff)),
      );
    }

    if (_errorMsg.isNotEmpty && _messages.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline,
                  color: Colors.redAccent, size: 40),
              const SizedBox(height: 12),
              Text('Lỗi kết nối: $_errorMsg',
                  style: const TextStyle(color: Colors.white70),
                  textAlign: TextAlign.center),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () {
                  setState(() {
                    _isLoading = true;
                    _errorMsg = '';
                  });
                  _initChat();
                },
                style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF4a9eff)),
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    if (_messages.isEmpty) {
      return const Center(
        child: Text('Chưa có tin nhắn nào.',
            style: TextStyle(color: Colors.white38, fontSize: 13)),
      );
    }

    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      itemCount: _messages.length,
      itemBuilder: (context, index) {
        final msg = _messages[index];
        final isOutgoing = msg.senderId == _deviceId;
        return _buildMessageBubble(msg, isOutgoing);
      },
    );
  }

  Widget _buildMessageBubble(ChatMessage msg, bool isOutgoing) {
    final senderLabel = isOutgoing
        ? 'Bạn'
        : msg.senderId == 'boss'
            ? 'Boss'
            : msg.senderId;
    final time = '${msg.createdAt.toLocal().hour.toString().padLeft(2, '0')}:${msg.createdAt.toLocal().minute.toString().padLeft(2, '0')}';

    return Align(
      alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 280),
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: isOutgoing
              ? const Color(0xFF4a9eff).withOpacity(0.85)
              : const Color(0xFF2a2a4a),
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(12),
            topRight: const Radius.circular(12),
            bottomLeft: Radius.circular(isOutgoing ? 12 : 2),
            bottomRight: Radius.circular(isOutgoing ? 2 : 12),
          ),
        ),
        child: Column(
          crossAxisAlignment:
              isOutgoing ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Text(senderLabel,
                style: TextStyle(
                    color: isOutgoing
                        ? Colors.white.withOpacity(0.8)
                        : const Color(0xFF4a9eff),
                    fontSize: 11,
                    fontWeight: FontWeight.w600)),
            const SizedBox(height: 3),
            Text(msg.body,
                style: const TextStyle(color: Colors.white, fontSize: 13)),
            const SizedBox(height: 3),
            Text(time,
                style: TextStyle(
                    color: Colors.white.withOpacity(0.5), fontSize: 10)),
          ],
        ),
      ),
    );
  }

  Widget _buildComposer() {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: const BoxDecoration(
        color: Color(0xFF16213e),
        border:
            Border(top: BorderSide(color: Color(0xFF2a2a4a), width: 1)),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputController,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              maxLength: 2000,
              maxLines: 1,
              decoration: InputDecoration(
                counterText: '',
                hintText: 'Nhập tin nhắn...',
                hintStyle: const TextStyle(color: Colors.white30),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                filled: true,
                fillColor: const Color(0xFF1a1a2e),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(20),
                  borderSide: BorderSide.none,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(20),
                  borderSide:
                      const BorderSide(color: Color(0xFF2a2a4a), width: 1),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(20),
                  borderSide:
                      const BorderSide(color: Color(0xFF4a9eff), width: 1),
                ),
              ),
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          const SizedBox(width: 8),
          Material(
            color: const Color(0xFF4a9eff),
            borderRadius: BorderRadius.circular(20),
            child: InkWell(
              onTap: _isSending ? null : _sendMessage,
              borderRadius: BorderRadius.circular(20),
              child: Container(
                width: 36,
                height: 36,
                alignment: Alignment.center,
                child: _isSending
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.send, color: Colors.white, size: 16),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
