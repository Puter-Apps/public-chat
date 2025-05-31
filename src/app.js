        // Use your created thread ID but with fallback for permissions
        let CHAT_UUID = 'f3d830de-ff0c-4915-88a9-d117d4e988a2';

        // Function to get chat history with permission fallback
        const get_chat_history = async (uuid) => {
            try {
                const results = [];
                for (let i = 0; i < 20; i++) {
                    const these_results = await puter.threads.list(uuid, i);
                    if (these_results.length < 1) {
                        break;
                    }
                    console.log('results and these_results', results, these_results);
                    results.push(...these_results);
                }
                return results;
            } catch (error) {
                console.warn('Could not load message history due to permissions:', error);
                // Try to load from KV store backup
                try {
                    const kvHistory = await puter.kv.get('chat-history-backup');
                    return kvHistory ? JSON.parse(kvHistory) : [];
                } catch (kvError) {
                    console.warn('No KV backup available:', kvError);
                    return [];
                }
            }
        };

        class Main {
            constructor() {
                this.username = null;
                this.users = new Map();
                this.sessionId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                this.lastKnownMessageCount = 0;
                this.presenceInterval = null;
                this.userRefreshInterval = null;
            }

            async main() {
                // Check authentication first
                if (!puter.auth.isSignedIn()) {
                    this.showAuthOverlay();
                    return;
                }

                this.hideAuthOverlay();

                try {
                    console.log('=== DEBUG INFO ===');
                    console.log('window.location.origin:', window.location.origin);
                    console.log('window.location.href:', window.location.href);
                    console.log('puter.appID:', puter.appID);
                    console.log('puter.appInstanceID:', puter.appInstanceID);
                    console.log('puter.env:', puter.env);
                    console.log('document.domain:', document.domain);
                    console.log('==================');

                    console.log('Using hardcoded chat thread:', CHAT_UUID);

                    // Set up send button event listener
                    const sendBtn = document.getElementById('sendButton');
                    sendBtn.addEventListener('click', async () => {
                        this.sendMessage();
                    });

                    // Initialize "Enter" listener exactly like reference app
                    document.getElementById('messageInput').addEventListener('keydown', event => {
                        if (event.key !== 'Enter') return;
                        if (event.shiftKey) return;
                        event.preventDefault();
                        this.sendMessage();
                    });

                    // Get user info using puter.auth.whoami() exactly like reference app
                    const user_info = await puter.auth.whoami();
                    this.username = user_info.username;

                    // Initialize user presence
                    await this.initializeUserPresence();

                    // Load chat history with complete fallback to KV store
                    try {
                        console.log('Attempting to load thread history...');
                        const history = await get_chat_history(CHAT_UUID);
                        for (const msg of history) {
                            this.appendMessage({
                                title: msg.user.username,
                                content: msg.text,
                                type: msg.user.username === this.username ? 'user-message' : 'other-message',
                            });
                        }
                        console.log('Thread history loaded successfully');
                    } catch (error) {
                        console.warn('Thread history failed, loading from KV store:', error);
                        // Load from KV store instead
                        try {
                            const kvMessages = await puter.kv.get('chat-messages');
                            if (kvMessages) {
                                const messages = JSON.parse(kvMessages);
                                for (const msg of messages) {
                                    this.appendMessage({
                                        title: msg.user.username,
                                        content: msg.text,
                                        type: msg.user.username === this.username ? 'user-message' : 'other-message',
                                    });
                                }
                                console.log('Loaded', messages.length, 'messages from KV store');
                            }
                        } catch (kvError) {
                            console.warn('No KV messages available:', kvError);
                        }
                    }

                    // Subscribe to the thread exactly like reference app
                    try {
                        await puter.threads.subscribe(CHAT_UUID, (event, msg) => {
                            if (event === 'post') {
                                // Track user who sent the message (but don't overwrite existing user data)
                                if (msg.user && msg.user.username) {
                                    // Only update if we don't already have this user, or update their last message time
                                    const existingUser = this.users.get(msg.user.username);
                                    const userInfo = existingUser || {
                                        username: msg.user.username,
                                        lastSeen: Date.now(),
                                        status: 'online',
                                        isActive: true
                                    };
                                    
                                    // Update last message time but preserve other info
                                    userInfo.lastMessage = Date.now();
                                    userInfo.lastSeen = Date.now();
                                    
                                    this.users.set(msg.user.username, userInfo);
                                    this.renderUsers();
                                }
                                
                                this.appendMessage({
                                    title: msg.user.username,
                                    content: msg.text,
                                    type: msg.user.username === this.username ? 'user-message' : 'other-message',
                                });
                            }
                        });
                        console.log('Thread subscription successful');
                    } catch (subscribeError) {
                        console.warn('Thread subscription failed, using KV polling:', subscribeError);
                        // Fall back to KV store polling
                        this.startKVPolling();
                    }

                    // Enable chat and update UI
                    this.enableChat();
                    this.updateConnectionStatus('Connected');
                    
                    // Start user presence updates
                    this.startUserPresence();

                } catch (error) {
                    console.error('Error initializing chat:', error);
                    this.updateConnectionStatus('Connection failed');
                    this.showNotification('Failed to initialize chat room', 'error');
                }
            }

            showAuthOverlay() {
                document.getElementById('authOverlay').style.display = 'flex';
                
                document.getElementById('authButton').addEventListener('click', async () => {
                    try {
                        await puter.auth.signIn();
                        this.main();
                    } catch (error) {
                        console.error('Authentication failed:', error);
                        this.showNotification('Sign-in failed. Please try again.', 'error');
                    }
                });
            }

            hideAuthOverlay() {
                document.getElementById('authOverlay').style.display = 'none';
            }

            async initializeUserPresence() {
                // Register current user as online
                const userInfo = {
                    username: this.username,
                    lastSeen: Date.now(),
                    status: 'online'
                };

                await puter.kv.set(`chat-user-${this.username}`, JSON.stringify(userInfo));
                this.users.set(this.username, userInfo);
                
                // Extract users from chat history and thread messages
                await this.extractUsersFromMessages();
                
                // Load other users from KV store
                await this.loadUsers();
            }

            async extractUsersFromMessages() {
                // Extract users who have participated in the chat thread
                try {
                    const history = await get_chat_history(CHAT_UUID);
                    const activeUsers = new Set();
                    
                    // Get users from message history
                    for (const msg of history) {
                        if (msg.user && msg.user.username) {
                            activeUsers.add(msg.user.username);
                        }
                    }
                    
                    // Add these users to our presence tracking
                    for (const username of activeUsers) {
                        if (!this.users.has(username)) {
                            const userInfo = {
                                username: username,
                                lastSeen: Date.now(),
                                status: 'online'
                            };
                            this.users.set(username, userInfo);
                        }
                    }
                    
                    console.log('Extracted users from messages:', Array.from(activeUsers));
                    this.renderUsers();
                    
                } catch (error) {
                    console.warn('Could not extract users from messages:', error);
                }
            }

            async loadUsers() {
                try {
                    const allKeys = await puter.kv.list();
                    const userKeys = allKeys.filter(key => key.startsWith('chat-user-'));
                    
                    const now = Date.now();
                    const fiveMinutesAgo = now - (5 * 60 * 1000);
                    
                    this.users.clear();
                    
                    for (const key of userKeys) {
                        try {
                            const userData = await puter.kv.get(key);
                            if (userData) {
                                const user = JSON.parse(userData);
                                if (user.lastSeen > fiveMinutesAgo) {
                                    this.users.set(user.username, user);
                                }
                            }
                        } catch (parseError) {
                            console.warn(`Failed to parse user data for ${key}:`, parseError);
                        }
                    }
                    
                    this.renderUsers();
                } catch (error) {
                    console.error('Error loading users:', error);
                }
            }

            renderUsers() {
                const userList = document.getElementById('userList');
                userList.innerHTML = '';

                if (this.users.size === 0) {
                    userList.innerHTML = '<div class="loading-placeholder">No users online</div>';
                    document.getElementById('userCount').textContent = '0';
                    document.getElementById('onlineCount').textContent = '0';
                    return;
                }

                const sortedUsers = Array.from(this.users.values())
                    .sort((a, b) => a.username.localeCompare(b.username));

                sortedUsers.forEach(user => {
                    const userElement = document.createElement('div');
                    userElement.className = 'user-item';

                    const avatar = document.createElement('div');
                    avatar.className = 'user-avatar';
                    avatar.textContent = user.username.charAt(0).toUpperCase();
                    
                    if (user.username === this.username) {
                        avatar.style.background = '#007bff';
                    } else {
                        avatar.style.background = '#6c757d';
                    }

                    const info = document.createElement('div');
                    info.className = 'user-info';

                    const name = document.createElement('div');
                    name.className = 'user-name';
                    name.textContent = user.username;

                    const status = document.createElement('div');
                    status.className = 'user-status';
                    status.textContent = user.username === this.username ? 'You' : 'Online';

                    info.appendChild(name);
                    info.appendChild(status);

                    userElement.appendChild(avatar);
                    userElement.appendChild(info);

                    userList.appendChild(userElement);
                });

                document.getElementById('userCount').textContent = this.users.size;
                document.getElementById('onlineCount').textContent = this.users.size;
            }

            appendMessage({ title, content, type }) {
                const chatDiv = document.getElementById('messagesArea');
                const messageDiv = document.createElement('div');
                messageDiv.className = `message ${type}`;

                const avatar = document.createElement('div');
                avatar.className = 'message-avatar';
                avatar.textContent = title.charAt(0).toUpperCase();

                const messageContent = document.createElement('div');
                messageContent.className = 'message-content';

                if (type !== 'user-message') {
                    const titleDiv = document.createElement('div');
                    titleDiv.className = 'message-author';
                    titleDiv.textContent = title;
                    messageContent.appendChild(titleDiv);
                }
                
                const contentsDiv = document.createElement('div');
                contentsDiv.className = 'message-text';

                if (typeof content === 'string') {
                    contentsDiv.textContent = content;
                } else {
                    contentsDiv.textContent = JSON.stringify(content, null, 2);
                }

                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                messageContent.appendChild(contentsDiv);
                messageContent.appendChild(timeDiv);

                messageDiv.appendChild(avatar);
                messageDiv.appendChild(messageContent);

                chatDiv.appendChild(messageDiv);

                // Update message count
                const messageCount = chatDiv.querySelectorAll('.message').length;
                document.getElementById('messageCount').textContent = messageCount;

                // Scroll to bottom
                chatDiv.scrollTop = chatDiv.scrollHeight;
            }

            async sendMessage() {
                const input = document.getElementById('messageInput');
                const userMessage = input.value;
                input.value = '';

                if (!userMessage.trim()) return;

                try {
                    // Try to send via threads first
                    await puter.threads.create({ text: userMessage }, CHAT_UUID);
                    console.log('Message sent via threads');
                } catch (error) {
                    console.warn('Threads not available, using KV store fallback:', error);
                    
                    // Fallback to KV store for messaging
                    const messageData = {
                        user: { username: this.username },
                        text: userMessage,
                        timestamp: Date.now(),
                        date: new Date().toISOString(), // Add ISO date for cleanup
                        id: Date.now() + '-' + Math.random().toString(36).substr(2, 9)
                    };
                    
                    // Get existing messages from KV
                    let messages = [];
                    try {
                        const existingMessages = await puter.kv.get('chat-messages');
                        if (existingMessages) {
                            messages = JSON.parse(existingMessages);
                        }
                    } catch (kvError) {
                        console.warn('Could not load existing KV messages:', kvError);
                    }
                    
                    // Add new message
                    messages.push(messageData);
                    
                    // Clean up old messages (keep only last 7 days)
                    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                    messages = messages.filter(msg => {
                        if (msg.timestamp) {
                            return msg.timestamp > sevenDaysAgo;
                        }
                        // For messages without timestamp, check date
                        if (msg.date) {
                            return new Date(msg.date).getTime() > sevenDaysAgo;
                        }
                        // Keep message if no timestamp or date (safety)
                        return true;
                    });
                    
                    // Keep only last 1000 messages as additional safety
                    messages = messages.slice(-1000);
                    
                    // Save back to KV store
                    await puter.kv.set('chat-messages', JSON.stringify(messages));
                    
                    // Display the message locally
                    this.appendMessage({
                        title: messageData.user.username,
                        content: messageData.text,
                        type: messageData.user.username === this.username ? 'user-message' : 'other-message',
                    });
                    
                    console.log('Message sent via KV store fallback');
                }
            }

            enableChat() {
                const messageInput = document.getElementById('messageInput');
                const sendButton = document.getElementById('sendButton');
                
                messageInput.disabled = false;
                messageInput.placeholder = 'Type your message...';
                sendButton.disabled = false;
            }

            updateConnectionStatus(status) {
                document.getElementById('connectionStatus').textContent = status;
            }

            startUserPresence() {
                // Immediately update presence and start heartbeat
                this.updateUserPresence();
                
                // Update presence every 10 seconds (frequent heartbeat)
                this.presenceInterval = setInterval(async () => {
                    await this.updateUserPresence();
                }, 10000);

                // Reload users every 8 seconds to see others quickly
                this.userRefreshInterval = setInterval(async () => {
                    await this.loadUsers();
                }, 8000);
                
                // Clean up presence when page unloads
                window.addEventListener('beforeunload', () => {
                    this.cleanupPresence();
                });
                
                // Handle visibility changes (tab switching)
                document.addEventListener('visibilitychange', async () => {
                    await this.updateUserPresence();
                });

                // Page focus/blur events
                window.addEventListener('focus', async () => {
                    await this.updateUserPresence();
                });

                window.addEventListener('blur', async () => {
                    await this.updateUserPresence();
                });
            }

            async updateUserPresence() {
                if (!this.username) return;

                try {
                    const userInfo = {
                        username: this.username,
                        lastSeen: Date.now(),
                        status: document.hidden ? 'away' : 'online',
                        isActive: true,
                        sessionId: this.sessionId || Date.now() // Unique session identifier
                    };

                    await puter.kv.set(`chat-user-${this.username}`, JSON.stringify(userInfo));
                    
                    // Update local user info
                    this.users.set(this.username, userInfo);
                    
                    console.log(`Updated presence for ${this.username} at ${new Date().toLocaleTimeString()}`);
                } catch (error) {
                    console.warn('Failed to update user presence:', error);
                }
            }

            cleanupPresence() {
                try {
                    if (this.presenceInterval) {
                        clearInterval(this.presenceInterval);
                    }
                    if (this.userRefreshInterval) {
                        clearInterval(this.userRefreshInterval);
                    }
                    
                    // Remove user from KV store
                    if (this.username) {
                        puter.kv.del(`chat-user-${this.username}`).catch(console.warn);
                    }
                } catch (error) {
                    console.warn('Error during cleanup:', error);
                }
            }

            startKVPolling() {
                // Poll KV store for new messages every 3 seconds
                setInterval(async () => {
                    try {
                        const messages = await puter.kv.get('chat-messages');
                        if (messages) {
                            const parsedMessages = JSON.parse(messages);
                            const lastKnownCount = this.lastKnownMessageCount || 0;
                            
                            if (parsedMessages.length > lastKnownCount) {
                                // New messages found
                                const newMessages = parsedMessages.slice(lastKnownCount);
                                for (const msg of newMessages) {
                                    // Skip our own messages (already displayed)
                                    if (msg.user.username !== this.username) {
                                        this.appendMessage({
                                            title: msg.user.username,
                                            content: msg.text,
                                            type: 'other-message',
                                        });
                                        
                                        // Track user
                                        const userInfo = {
                                            username: msg.user.username,
                                            lastSeen: Date.now(),
                                            status: 'online'
                                        };
                                        this.users.set(msg.user.username, userInfo);
                                        this.renderUsers();
                                    }
                                }
                                this.lastKnownMessageCount = parsedMessages.length;
                            }
                        }
                    } catch (error) {
                        console.warn('Error polling KV messages:', error);
                    }
                }, 3000);
            }

            showNotification(message, type = 'success') {
                const notification = document.createElement('div');
                notification.className = `notification ${type === 'error' ? 'error' : ''}`;
                notification.textContent = message;
                
                document.body.appendChild(notification);
                
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.remove();
                    }
                }, 4000);
            }
        }

        // Initialize exactly like reference app
        document.addEventListener('DOMContentLoaded', () => {
            const instance = new Main();
            instance.main();
        });