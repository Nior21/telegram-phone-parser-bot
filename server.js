require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const {
    Telegraf,
    Markup
} = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Инициализация базы данных
const db = new sqlite3.Database(process.env.DATABASE_URL || './data/database.db');

// Инициализация таблиц
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            normalized_phone TEXT UNIQUE NOT NULL,
            name TEXT,
            company TEXT,
            context TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS parsed_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            chat_id INTEGER NOT NULL,
            contact_id INTEGER,
            original_text TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
        )
    `);
});

// Утилиты для работы с базой данных
const database = {
    saveContact: (phone, normalizedPhone, name = null, company = null, context = null) => {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT OR IGNORE INTO contacts (phone, normalized_phone, name, company, context) 
                 VALUES (?, ?, ?, ?, ?)`,
                [phone, normalizedPhone, name, company, context],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    },

    findContactByPhone: (phone) => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM contacts WHERE normalized_phone = ?`,
                [phone],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    },

    searchContacts: (query) => {
        return new Promise((resolve, reject) => {
            const searchQuery = `%${query}%`;
            db.all(
                `SELECT * FROM contacts 
                 WHERE normalized_phone LIKE ? 
                    OR phone LIKE ? 
                    OR name LIKE ? 
                    OR company LIKE ? 
                    OR context LIKE ?
                 ORDER BY updated_at DESC`,
                [searchQuery, searchQuery, searchQuery, searchQuery, searchQuery],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    },

    updateContact: (id, updates) => {
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`,
                values,
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    },

    getAllContacts: (limit = 50) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT * FROM contacts ORDER BY updated_at DESC LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    },

    getContactById: (id) => {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM contacts WHERE id = ?`,
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }
};

// Утилиты для парсинга телефонов
class PhoneParser {
    static normalizePhone(phone) {
        let normalized = phone.replace(/[^\d+]/g, '');

        if (normalized.startsWith('8')) {
            normalized = '+7' + normalized.substring(1);
        } else if (normalized.startsWith('7') && !normalized.startsWith('+7')) {
            normalized = '+' + normalized;
        } else if (/^9\d{9}$/.test(normalized)) {
            normalized = '+7' + normalized;
        } else if (/^\d{10}$/.test(normalized)) {
            normalized = '+7' + normalized;
        }

        return normalized;
    }

    static parsePhoneNumbers(text) {
        const phoneRegex = /(?:\+?\d[\d\s\-\(\)]{7,}\d|\d[\d\s\-\(\)]{7,}\d)/g;
        const matches = text.match(phoneRegex) || [];

        return matches.map(phone => ({
            original: phone.trim(),
            normalized: this.normalizePhone(phone)
        }));
    }
}

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Обработчик сообщений
bot.on('message', async (ctx) => {
    try {
        const text = ctx.message.text || '';

        if (!text.trim()) return;

        const phones = PhoneParser.parsePhoneNumbers(text);

        if (phones.length === 0) return;

        const responses = [];
        const webAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEB_APP_URL;

        for (const phone of phones) {
            let contact = await database.findContactByPhone(phone.normalized);

            if (!contact) {
                const contactId = await database.saveContact(
                    phone.original,
                    phone.normalized,
                    null,
                    null,
                    text.substring(0, 200)
                );
                contact = await database.findContactByPhone(phone.normalized);
            }

            let response = `📞 Найден телефон:\n\`${phone.normalized}\``;

            if (contact.name) {
                response += `\n👤 \`${contact.name}\``;
            }
            if (contact.company) {
                response += `\n🏢 \`${contact.company}\``;
            }

            responses.push(response);
        }

        if (responses.length > 0) {
            await ctx.reply(responses.join('\n\n'), {
                reply_to_message_id: ctx.message.message_id,
                parse_mode: 'Markdown'
            });

            if (webAppUrl) {
                await ctx.reply('Действия с контактами:', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                Markup.button.webApp(
                                    '🔍 Поиск и редактирование',
                                    webAppUrl
                                )
                            ]
                        ]
                    }
                });
            }
        }

    } catch (error) {
        console.error('Error processing message:', error);
    }
});

// Команды бота
bot.command('start', (ctx) => {
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEB_APP_URL;
    ctx.reply(
        '🤖 Бот для парсинга телефонных номеров\n\n' +
        'Я автоматически нахожу номера телефонов в сообщениях и сохраняю их в базу.\n\n' +
        'Доступные команды:\n' +
        '/add <номер> [имя] [компания] - добавить контакт\n' +
        '/search <запрос> - поиск контактов\n' +
        '/web - открыть веб-интерфейс',
        webAppUrl ? {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.webApp('📱 Открыть веб-интерфейс', webAppUrl)]
                ]
            }
        } : {}
    );
});

bot.command('web', (ctx) => {
    const webAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEB_APP_URL;
    if (webAppUrl) {
        ctx.reply('Веб-интерфейс для управления контактами:', {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.webApp('🔍 Открыть поиск', webAppUrl)]
                ]
            }
        });
    } else {
        ctx.reply('Веб-интерфейс не настроен');
    }
});

bot.command('add', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);

    if (args.length < 1) {
        return ctx.reply('Использование: /add <номер телефона> [имя] [компания]');
    }

    const phone = PhoneParser.normalizePhone(args[0]);
    const name = args[1] || null;
    const company = args[2] || null;

    try {
        await database.saveContact(args[0], phone, name, company);
        await ctx.reply(`✅ Контакт сохранен:\n\`${phone}\`${name ? `\n👤 \`${name}\`` : ''}${company ? `\n🏢 \`${company}\`` : ''}`, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        await ctx.reply('❌ Ошибка при сохранении контакта');
    }
});

bot.command('search', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ');

    if (!query) {
        return ctx.reply('Использование: /search <запрос>');
    }

    try {
        const contacts = await database.searchContacts(query);

        if (contacts.length === 0) {
            return ctx.reply('Ничего не найдено');
        }

        const message = contacts.slice(0, 5).map(contact =>
            `📞 \`${contact.normalized_phone}\`\n${contact.name ? `👤 ${contact.name}\n` : ''}${contact.company ? `🏢 ${contact.company}\n` : ''}`
        ).join('\n');

        const webAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEB_APP_URL;
        const replyMarkup = webAppUrl ? {
            inline_keyboard: [
                [Markup.button.webApp('🔍 Открыть поиск', webAppUrl)]
            ]
        } : undefined;

        await ctx.reply(message + '\n\nДля полного поиска используйте веб-интерфейс:', {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
    } catch (error) {
        await ctx.reply('❌ Ошибка при поиске');
    }
});

// API endpoints
app.get('/api/contacts', async (req, res) => {
    try {
        const {
            search,
            page = 1,
            limit = 20
        } = req.query;
        let contacts;

        if (search) {
            contacts = await database.searchContacts(search);
        } else {
            contacts = await database.getAllContacts(limit);
        }

        res.json({
            success: true,
            data: contacts
        });
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({
            success: false,
            error: 'Server error'
        });
    }
});

app.get('/api/contacts/:id', async (req, res) => {
    try {
        const contact = await database.getContactById(req.params.id);

        if (contact) {
            res.json({
                success: true,
                data: contact
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Contact not found'
            });
        }
    } catch (error) {
        console.error('Error fetching contact:', error);
        res.status(500).json({
            success: false,
            error: 'Server error'
        });
    }
});

app.put('/api/contacts/:id', async (req, res) => {
    try {
        const {
            name,
            company,
            context
        } = req.body;
        const updates = {};

        if (name !== undefined) updates.name = name;
        if (company !== undefined) updates.company = company;
        if (context !== undefined) updates.context = context;

        await database.updateContact(req.params.id, updates);
        res.json({
            success: true
        });
    } catch (error) {
        console.error('Error updating contact:', error);
        res.status(500).json({
            success: false,
            error: 'Server error'
        });
    }
});

// Health check endpoint для Render
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'telegram-phone-parser-bot'
    });
});

// Веб-интерфейс
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск
const startServer = async () => {
    try {
        // Запускаем веб-сервер
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);

            // В production используем webhook
            if (process.env.NODE_ENV === 'production') {
                const webhookUrl = `${process.env.RENDER_EXTERNAL_URL || process.env.WEB_APP_URL}/webhook`;
                bot.telegram.setWebhook(webhookUrl);
                console.log(`🌐 Webhook set to: ${webhookUrl}`);

                // Обработчик webhook для Render
                app.use(bot.webhookCallback('/webhook'));
            } else {
                // В development используем polling
                bot.launch();
                console.log('🤖 Bot started in polling mode');
            }
        });

        // Graceful shutdown
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();