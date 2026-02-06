const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        this.db = new sqlite3.Database(path.join(__dirname, 'data', 'database.db'));
        this.initDatabase();
    }

    initDatabase() {
        this.db.run(`
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

        this.db.run(`
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
    }

    async saveContact(phone, normalizedPhone, name = null, company = null, context = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO contacts (phone, normalized_phone, name, company, context) 
                 VALUES (?, ?, ?, ?, ?)`,
                [phone, normalizedPhone, name, company, context],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async findContactByPhone(phone) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM contacts WHERE normalized_phone = ?`,
                [phone],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async searchContacts(query) {
        return new Promise((resolve, reject) => {
            const searchQuery = `%${query}%`;
            this.db.all(
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
    }

    async updateContact(id, updates) {
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
        fields.push('updated_at = CURRENT_TIMESTAMP');

        values.push(id);

        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`,
                values,
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async getAllContacts(limit = 50) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM contacts ORDER BY updated_at DESC LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async logParsedMessage(messageId, chatId, contactId, originalText) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO parsed_messages (message_id, chat_id, contact_id, original_text) 
                 VALUES (?, ?, ?, ?)`,
                [messageId, chatId, contactId, originalText],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }
}

module.exports = new Database();