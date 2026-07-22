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
  final TextEditingController _activationController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  Timer? _pollTimer;
  bool _isSending = false;
  bool _needsActivation = false;
  bool _keyEntryRequired = false;
  bool _showActivationField = false;
  bool _isActivating = false;
  String _activationError = '';

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

  Future<bool> _registerDevice(String hostname, {String? activationKey}) async {
    try {
      final uri = Uri.parse('$_apiServer/api/device/save-password');
      final payload = <String, dynamic>{
        'id': _deviceId,
        'pass': '',
        'hostname': hostname,
        'chat_token': _chatToken,
      };
      if (activationKey != null && activationKey.isNotEmpty) {
        payload['activation_key'] = activationKey;
      }
      final response = await http.post(uri,
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode(payload));
      if (response.statusCode == 200) {
        _keyEntryRequired = false;
        _showActivationField = false;
        debugPrint('Device activated: $_deviceId ($hostname)');
        return true;
      }
      if (response.statusCode == 202) {
        try {
          final data = jsonDecode(response.body) as Map<String, dynamic>;
          _keyEntryRequired = data['key_entry_required'] == true;
        } catch (_) {}
        debugPrint('Device is waiting for a chat key: $_deviceId');
        return false;
      }
      String message = 'Không xác thực được key.';
      try {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        message = data['error']?.toString() ?? message;
        if (data['code'] == 'KEY_ENTRY_REQUIRED') {
          _keyEntryRequired = true;
        }
      } catch (_) {}
      throw Exception(message);
    } catch (e) {
      debugPrint('Device registration error: $e');
      rethrow;
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

      // New devices appear on the web as pending. Admin can bind a key directly,
      // or require the one-time key field shown inside this chat window.
      _needsActivation = !await _registerDevice(Platform.localHostname);
      if (!_needsActivation) await _loadMessages(reset: true);

      if (!mounted) return;
      setState(() {
        _isLoading = false;
      });

      _pollTimer = Timer.periodic(
          const Duration(milliseconds: 2500), (_) => _refreshChatState());
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

  Future<void> _refreshChatState() async {
    if (_needsActivation) {
      try {
        final activated = await _registerDevice(Platform.localHostname);
        if (activated) {
          if (mounted) {
            setState(() {
              _needsActivation = false;
              _activationError = '';
            });
          }
          await _loadMessages(reset: true);
        }
      } catch (_) {}
      return;
    }
    await _loadMessages();
  }

  Future<void> _activateChat() async {
    final key = _activationController.text.trim();
    if (key.isEmpty || _isActivating) return;
    setState(() {
      _isActivating = true;
      _activationError = '';
    });
    try {
      final activated = await _registerDevice(
        Platform.localHostname,
        activationKey: key,
      );
      if (!activated) throw Exception('Key chưa kích hoạt được máy này.');
      _activationController.clear();
      if (mounted) setState(() => _needsActivation = false);
      await _loadMessages(reset: true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _activationError = e.toString().replaceFirst('Exception: ', '');
        });
      }
    } finally {
      if (mounted) setState(() => _isActivating = false);
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
      if (response.statusCode == 403) {
        try {
          final data = jsonDecode(response.body) as Map<String, dynamic>;
          _keyEntryRequired = data['code'] == 'KEY_ENTRY_REQUIRED';
        } catch (_) {}
        if (mounted) setState(() => _needsActivation = true);
        return;
      }
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
          _scrollController.animateTo(
              _scrollController.position.maxScrollExtent + 60,
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
      } else if (response.statusCode == 403 && mounted) {
        try {
          final data = jsonDecode(response.body) as Map<String, dynamic>;
          _keyEntryRequired = data['code'] == 'KEY_ENTRY_REQUIRED';
        } catch (_) {}
        setState(() => _needsActivation = true);
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
    _activationController.dispose();
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
            backgroundColor: Colors.transparent,
            body: Padding(
              padding: const EdgeInsets.all(7),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: Container(
                  decoration: BoxDecoration(
                    color: const Color(0xE6122033),
                    border: Border.all(color: const Color(0x334DDCCB)),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Column(
                    children: [
                      _buildHeader(),
                      Expanded(child: _buildMessageArea()),
                      if (!_needsActivation) _buildComposer(),
                    ],
                  ),
                ),
              ),
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
          color: Color(0xB814263B),
          border:
              Border(bottom: BorderSide(color: Color(0x334DDCCB), width: 1)),
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
                color: const Color(0x66101E30),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: const Color(0x334DDCCB)),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _channel,
                  dropdownColor: const Color(0xFF16213e),
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                  icon: const Icon(Icons.arrow_drop_down,
                      color: Colors.white54, size: 16),
                  items: const [
                    DropdownMenuItem(value: 'boss', child: Text('Nhắn boss')),
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
                child: Icon(Icons.close, color: Colors.white54, size: 18),
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

    if (_needsActivation) return _buildActivationGate();

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

  Widget _buildActivationGate() {
    final showKeyField = _keyEntryRequired || _showActivationField;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: const Color(0x224DDCCB),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0x554DDCCB)),
              ),
              child: const Icon(Icons.key_rounded,
                  color: Color(0xFF5EEAD4), size: 25),
            ),
            const SizedBox(height: 16),
            Text(showKeyField ? 'Yêu cầu nhập key mới' : 'Đang chờ kích hoạt',
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.w700)),
            const SizedBox(height: 7),
            Text(
              showKeyField
                  ? 'Nhập key do quản trị viên cấp. Key dùng một lần sẽ tự hủy sau khi máy được xác thực.'
                  : 'Máy đã gửi yêu cầu lên hệ thống. Admin có thể gán key trực tiếp mà bạn không cần nhập gì.',
              textAlign: TextAlign.center,
              style: const TextStyle(
                  color: Colors.white54, fontSize: 12, height: 1.45),
            ),
            const SizedBox(height: 18),
            if (showKeyField) ...[
              TextField(
                controller: _activationController,
                autofocus: true,
                enabled: !_isActivating,
                style: const TextStyle(
                    color: Colors.white, fontSize: 13, letterSpacing: .4),
                decoration: InputDecoration(
                  hintText: 'p20412345',
                  errorText: _activationError.isEmpty ? null : _activationError,
                  prefixIcon: const Icon(Icons.lock_open_rounded,
                      color: Color(0xFF5EEAD4), size: 18),
                  filled: true,
                  fillColor: const Color(0x66101E30),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: Color(0x334DDCCB)),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: Color(0x334DDCCB)),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: Color(0xFF5EEAD4)),
                  ),
                ),
                onSubmitted: (_) => _activateChat(),
              ),
              const SizedBox(height: 10),
            ],
            SizedBox(
              width: double.infinity,
              height: 42,
              child: ElevatedButton(
                onPressed: _isActivating
                    ? null
                    : showKeyField
                        ? _activateChat
                        : () => setState(() => _showActivationField = true),
                style: ElevatedButton.styleFrom(
                  foregroundColor: const Color(0xFF052B27),
                  backgroundColor: const Color(0xFF5EEAD4),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                child: _isActivating
                    ? const SizedBox(
                        width: 17,
                        height: 17,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Color(0xFF052B27)))
                    : Text(showKeyField ? 'Mở khóa chat' : 'Tôi đã có key',
                        style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
            ),
            const SizedBox(height: 10),
            const Text('Nếu admin gán key trực tiếp, cửa sổ sẽ tự mở khóa.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white30, fontSize: 10)),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageBubble(ChatMessage msg, bool isOutgoing) {
    final senderLabel = isOutgoing
        ? 'Bạn'
        : msg.senderId == 'boss'
            ? 'Boss'
            : msg.senderId;
    final time =
        '${msg.createdAt.toLocal().hour.toString().padLeft(2, '0')}:${msg.createdAt.toLocal().minute.toString().padLeft(2, '0')}';

    return Align(
      alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 280),
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: isOutgoing ? const Color(0xDD178F86) : const Color(0xA6283A50),
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
        color: Color(0xB814263B),
        border: Border(top: BorderSide(color: Color(0x334DDCCB), width: 1)),
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
                fillColor: const Color(0x66101E30),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(20),
                  borderSide: BorderSide.none,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(20),
                  borderSide:
                      const BorderSide(color: Color(0x334DDCCB), width: 1),
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
            color: const Color(0xFF2DD4BF),
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
