require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || "").split(',');

// --- OAUTH2: GİRİŞ ENDPOINTİ ---
app.get('/api/auth/login', (req, res) => {
    const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.members.read`;
    res.redirect(redirectUrl);
});

// --- OAUTH2: CALLBACK (DÖNÜŞ) ENDPOINTİ ---
app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Discord yetkilendirmesi iptal edildi.");

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI
            })
        });
        const tokenData = await tokenResponse.json();

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();

        // Admin Kontrolü
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        let isAdmin = false;

        if (ADMIN_IDS.includes(userData.id)) {
            isAdmin = true;
        } else {
            try {
                const member = await guild.members.fetch(userData.id);
                isAdmin = member.permissions.has('Administrator');
            } catch (e) {
                isAdmin = false;
            }
        }

        // Netlify'daki (veya yereldeki) siteye kullanıcı verileriyle geri yönlendir
        // Not: Canlıda Netlify adresini yazabilirsin, şimdilik local'e yönlendiriyoruz:
        const clientRedirect = `http://127.0.0.1:5500/index.html?user=${encodeURIComponent(JSON.stringify({
            id: userData.id,
            username: userData.username,
            avatar: `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`,
            isAdmin: isAdmin
        }))}`;

        res.redirect(clientRedirect);

    } catch (err) {
        console.error("OAuth2 Hata:", err);
        res.status(500).send("Discord OAuth2 sırasında bir hata oluştu.");
    }
});

// --- SOCKET.IO & DİSCORD CANLI TICKET ENTEGRASYONU ---
const activeSockets = new Map();
const channelToSocket = new Map();

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const socketId = channelToSocket.get(message.channel.id);
    if (socketId) {
        io.to(socketId).emit('chat_message', {
            sender: message.author.username,
            text: message.content,
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
            avatar: message.author.displayAvatarURL()
        });
    }
});

io.on('connection', (socket) => {
    socket.on('start_sales_chat', async (data) => {
        const { username, product, inviteLink } = data;
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (!guild) return socket.emit('error', 'Discord sunucusu bulunamadı!');

        try {
            let category = guild.channels.cache.find(
                c => c.name === process.env.CATEGORY_NAME && c.type === ChannelType.GuildCategory
            );
            if (!category) {
                category = await guild.channels.create({ name: process.env.CATEGORY_NAME, type: ChannelType.GuildCategory });
            }

            const cleanUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '');
            const channel = await guild.channels.create({
                name: `satıs-${cleanUsername}`,
                type: ChannelType.GuildText,
                parent: category.id,
                topic: `Müşteri: ${username} | Ürün: ${product}`
            });

            activeSockets.set(socket.id, channel.id);
            channelToSocket.set(channel.id, socket.id);

            await channel.send({
                content: `🎉 **Yeni Sipariş Oluşturuldu!** @everyone\n\n👤 **Müşteri:** ${username}\n🛒 **Ürün:** ${product}\n🔗 **Sunucu:** ${inviteLink || 'Belirtilmedi'}`
            });

            socket.emit('chat_started', { channelId: channel.id });
        } catch (err) {
            console.error('Kanal hatası:', err);
        }
    });

    socket.on('send_site_message', async (data) => {
        const channelId = activeSockets.get(socket.id);
        if (channelId) {
            const channel = client.channels.cache.get(channelId);
            if (channel) await channel.send(`💬 **[Müşteri] ${data.username}:** ${data.message}`);
        }
    });
});

client.once('ready', () => {
    console.log(`✅ XYT Bot Aktif: ${client.user.tag}`);
});

server.listen(3000, () => {
    console.log('🚀 Backend sunucusu 3000 portunda çalışıyor.');
    client.login(process.env.DISCORD_TOKEN);
});