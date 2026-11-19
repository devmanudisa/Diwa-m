/**
 * Pterodactyl Panel WhatsApp Bot (Console Pairing Code)
 * Pupa iragena haduwe uberlata denna thama hum 😒 @Kcey
 */

const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const readline = require('readline');
const NodeCache = require('node-cache');
const axios = require('axios');
const mongoose = require('mongoose');
const http = require('http'); 

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const { sms } = require('./lib/msg');
const config = require('./config');
const events = require('./command');

// ====================== PTERODACTYL ANTI-KILL (PORT BIND) ======================
const server = http.createServer((req, res) => {
    res.write('Bot is running!');
    res.end();
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🌐 Pterodactyl Network Port Bound on ${PORT}`));

// ====================== CONFIG ======================
const SESSION_BASE_PATH = './sessions';
const msgRetryCounterCache = new NodeCache();
require('events').EventEmitter.defaultMaxListeners = 500;

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI || '';
let Session = null;
let useMongo = false;

if (MONGODB_URI && MONGODB_URI.startsWith('mongodb')) {
    mongoose.connect(MONGODB_URI).then(() => {
        console.log('✅ MongoDB Connected');
        useMongo = true;
    }).catch(err => console.log('⚠️ MongoDB connection failed:', err.message));

    const SessionSchema = new mongoose.Schema({ sessionId: String, data: Object });
    Session = mongoose.model('Session', SessionSchema);
}

// ====================== PLUGINS ======================
try {
    const pluginPath = './plugins/';
    if (fs.existsSync(pluginPath)) {
        fs.readdirSync(pluginPath).forEach((plugin) => {
            if (path.extname(plugin).toLowerCase() === '.js') {
                try { require(pluginPath + plugin); } catch (e) { console.log(`⚠️ Error loading plugin ${plugin}:`, e.message); }
            }
        });
        console.log('✅ All Plugins Loaded Successfully');
    }
} catch (e) {}

let handleViewOnce;
try { handleViewOnce = require('./plugins/antiviewonce').handleViewOnce; } catch (e) {}

let handleJilhubReply;
try { handleJilhubReply = require('./plugins/jilhub').handleJilhubReply; } catch (e) {}

const commandMap = new Map();
for (const cmd of events.commands) {
    if (cmd.pattern) commandMap.set(cmd.pattern, cmd);
    if (cmd.alias) {
        for (const alias of cmd.alias) {
            if (!commandMap.has(alias)) commandMap.set(alias, cmd);
        }
    }
}

// ====================== STATE ======================
const activeSockets = {};
const keepAliveTimers = {};
const reconnectTimers = {};
const saveDebounceTimers = {};
const fileCache = {};

// ====================== SESSION HELPERS ======================
async function restoreSession(sessionId, sessionPath) {
    if (!useMongo || !Session) return;
    try {
        const doc = await Session.findOne({ sessionId });
        if (doc && doc.data) {
            await fs.ensureDir(sessionPath);
            for (const [file, content] of Object.entries(doc.data)) {
                await fs.writeFile(path.join(sessionPath, file), content, 'utf-8');
            }
        }
    } catch (e) {}
}

async function saveSession(sessionId, sessionPath) {
    if (!useMongo || !Session) return;
    try {
        const files = await fs.readdir(sessionPath);
        let data = {};
        let hasChanges = false;
        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(sessionPath, file), 'utf-8');
                const cacheKey = `${sessionId}:${file}`;
                if (fileCache[cacheKey] !== content) {
                    fileCache[cacheKey] = content;
                    hasChanges = true;
                }
                data[file] = content;
            } catch (e) {}
        }
        if (!hasChanges) return;
        await Session.findOneAndUpdate({ sessionId }, { data }, { upsert: true });
    } catch (err) {}
}

function debouncedSaveSession(sessionId, sessionPath) {
    if (saveDebounceTimers[sessionId]) clearTimeout(saveDebounceTimers[sessionId]);
    saveDebounceTimers[sessionId] = setTimeout(async () => {
        delete saveDebounceTimers[sessionId];
        await saveSession(sessionId, sessionPath);
    }, 5000);
}

function cleanupSession(sessionId) {
    if (activeSockets[sessionId]) {
        try { activeSockets[sessionId].end(undefined); } catch (e) {}
        delete activeSockets[sessionId];
    }
    if (keepAliveTimers[sessionId]) {
        clearInterval(keepAliveTimers[sessionId]);
        delete keepAliveTimers[sessionId];
    }
    if (reconnectTimers[sessionId]) {
        clearTimeout(reconnectTimers[sessionId]);
        delete reconnectTimers[sessionId];
    }
}

// ====================== PAIR / CONNECT ======================
async function Pair(number) {
    const xnumber = String(number).replace(/[^0-9]/g, '');
    if (!xnumber || xnumber.length < 10) return;

    const sessionId = `bot_${xnumber}`;
    const sessionPath = path.join(SESSION_BASE_PATH, sessionId);

    if (activeSockets[sessionId]) return;

    try {
        await restoreSession(sessionId, sessionPath);
        await fs.ensureDir(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: 'silent' });

        const sock = makeWASocket({
            version,
            logger,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        activeSockets[sessionId] = sock;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            debouncedSaveSession(sessionId, sessionPath);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                cleanupSession(sessionId);

                if (!isLoggedOut) {
                    reconnectTimers[sessionId] = setTimeout(() => Pair(xnumber), 5000);
                } else {
                    if (useMongo && Session) await Session.findOneAndDelete({ sessionId }).catch(() => {});
                    await fs.remove(sessionPath).catch(() => {});
                }
            } else if (connection === 'open') {
                console.log(`\n✅✅✅ BOT CONNECTED: ${xnumber} ✅✅✅\n`);
                
                const botNumber = sock.user.id.split(':')[0];
                if (!config.OWNER.includes(botNumber)) config.OWNER.push(botNumber);

                try {
                    const jid = xnumber + '@s.whatsapp.net';
                    await sock.sendMessage(jid, {
                        text: `*Bot Active!* ✅\n\nYour bot is now connected successfully.\n\nPrefix: \`${config.PREFIX}\``
                    });
                } catch (e) {}

                keepAliveTimers[sessionId] = setInterval(async () => {
                    if (!activeSockets[sessionId]) return;
                    sock.sendPresenceUpdate('available', sock.user.id).catch(() => {});
                }, 30000);
            }
        });

        sock.ev.on('messages.upsert', async (mek) => {
            try {
                mek = mek.messages[0];
                if (!mek.message) return;
                mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

                if (mek.key && mek.key.remoteJid === 'status@broadcast') return;

                if (handleViewOnce) handleViewOnce(sock, mek).catch(() => {});
                if (handleJilhubReply) handleJilhubReply(sock, mek).catch(() => {});

                const m = sms(sock, mek);
                const type = getContentType(mek.message);
                const from = mek.key.remoteJid;
                const isGroup = from.endsWith('@g.us');
                
                const sender = mek.key.fromMe ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : (mek.key.participant || mek.key.remoteJid);
                const senderNumber = sender.split('@')[0];
                const botNumber = sock.user.id.split(':')[0];
                const botNumber2 = await jidNormalizedUser(sock.user.id);
                const isMe = botNumber.includes(senderNumber);
                const isOwner = isMe || config.OWNER.includes(senderNumber);
                const pushname = mek.pushName || 'User';

                const body = 
                    type === 'conversation' ? mek.message.conversation :
                    type === 'extendedTextMessage' ? mek.message.extendedTextMessage.text :
                    type === 'imageMessage' && mek.message.imageMessage?.caption ? mek.message.imageMessage.caption :
                    type === 'videoMessage' && mek.message.videoMessage?.caption ? mek.message.videoMessage.caption :
                    m.msg?.text || m.msg?.conversation || m.msg?.caption || '';
                
                const prefix = config.PREFIX;
                const isCmd = body.startsWith(prefix);
                const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                
                const groupMetadata = isGroup ? await sock.groupMetadata(from).catch(() => null) : null;
                const groupName = isGroup && groupMetadata ? groupMetadata.subject : '';
                const participants = isGroup && groupMetadata ? groupMetadata.participants : [];
                const groupAdmins = isGroup ? getGroupAdmins(participants) : [];
                const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
                const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

                const reply = async (teks, options = {}) => {
                    return sock.sendMessage(from, { text: teks }, { quoted: mek, ...options });
                };

                if (isCmd) await sock.readMessages([mek.key]).catch(() => {});
                
                if (isCmd) {
                    const cmd = commandMap.get(command);
                    if (cmd) {
                        try {
                            await cmd.function(sock, mek, m, {
                                from, quoted: mek, body, isCmd, command, args, q,
                                isGroup, sender, senderNumber, botNumber2, botNumber,
                                pushname, isMe, isOwner, groupMetadata, groupName,
                                participants, groupAdmins, isBotAdmins, isAdmins, reply
                            });
                        } catch (err) {
                            console.error('Command Error:', err);
                        }
                    }
                }
            } catch (err) {}
        });

        if (!sock.authState.creds.registered) {
            console.log('\n⏳ Generating pairing code for', xnumber, '...\n');
            setTimeout(async () => {
                try {
                    const pairingCode = await sock.requestPairingCode(xnumber);
                    console.log('══════════════════════════════════════════');
                    console.log(`               ${pairingCode}               `);
                    console.log('══════════════════════════════════════════');
                } catch (err) {
                    cleanupSession(sessionId);
                }
            }, 3000);
        }
    } catch (err) {
        cleanupSession(sessionId);
    }
}

// ====================== START ======================
async function start() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   Pterodactyl WhatsApp Bot (Console) ║');
    console.log('╚══════════════════════════════════════╝\n');

    await fs.ensureDir(SESSION_BASE_PATH);

    try {
        const folders = await fs.readdir(SESSION_BASE_PATH);
        for (const folder of folders) {
            if (folder.startsWith('bot_')) {
                const number = folder.replace('bot_', '');
                console.log('🔄 Restoring local session:', number);
                await Pair(number);
                await sleep(1500);
            }
        }
    } catch (e) {}

    if (useMongo && Session) {
        try {
            const sessions = await Session.find({});
            for (const s of sessions) {
                if (!s.sessionId) continue;
                const number = s.sessionId.replace('bot_', '');
                if (!activeSockets[s.sessionId]) {
                    console.log('🔄 Restoring Mongo session:', number);
                    await Pair(number);
                    await sleep(1500);
                }
            }
        } catch (e) {}
    }

    if (Object.keys(activeSockets).length === 0) {
        const envNumber = process.env.BOT_NUMBER ? process.env.BOT_NUMBER.replace(/[^0-9]/g, '') : null;
        if (envNumber) {
            await Pair(envNumber);
        } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const ask = () => {
                rl.question('\n📱 Enter WhatsApp number (ex: 94771234567):\n> ', async (input) => {
                    const num = input.trim().replace(/[^0-9]/g, '');
                    if (!num || num.length < 10) return ask();
                    rl.close();
                    await Pair(num);
                });
            };
            ask();
        }
    }
}

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

start().catch(() => {});
