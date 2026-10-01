try {
    require('dotenv').config();
} catch (e) {
    // dotenv не установлен или не требуется в продакшене
}

const express = require('express');
const { Pool, types } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Парсинг BIGINT (20) и NUMERIC (1700) в JS Number
types.setTypeParser(20, (val) => (val === null ? 0 : Number(val)));
types.setTypeParser(1700, (val) => (val === null ? 0 : Number(val)));

// ======================================================
// POSTGRESQL POOL
// ======================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/game_db',
    ssl: process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL?.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool unexpected error:', err);
});

// ======================================================
// MIDDLEWARE
// ======================================================

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ======================================================
// ИНИЦИАЛИЗАЦИЯ И СИНХРОНИЗАЦИЯ СХЕМЫ БАЗЫ ДАННЫХ
// ======================================================

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves (
                user_id VARCHAR(255) PRIMARY KEY,
                save_data JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255) DEFAULT 'Оператор',
                avatar VARCHAR(50) DEFAULT '👷',
                rebirths BIGINT DEFAULT 0,
                energy NUMERIC DEFAULT 0,
                total_produced NUMERIC DEFAULT 0,
                city_level INT DEFAULT 0,
                city_progress NUMERIC DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS avatar VARCHAR(50) DEFAULT '👷';
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS total_produced NUMERIC DEFAULT 0;
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS city_level INT DEFAULT 0;
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS city_progress NUMERIC DEFAULT 0;
            ALTER TABLE leaderboard ALTER COLUMN energy TYPE NUMERIC USING energy::numeric;
            ALTER TABLE leaderboard ALTER COLUMN total_produced TYPE NUMERIC USING total_produced::numeric;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS leaderboard_rebirths_idx ON leaderboard(rebirths DESC, energy DESC);
            CREATE INDEX IF NOT EXISTS leaderboard_total_idx ON leaderboard(total_produced DESC);
        `);

        console.log('✓ PostgreSQL schema initialized & synchronized');
    } catch (error) {
        console.error('Database initialization error:', error);
        process.exit(1);
    }
}

// ======================================================
// ВАЛИДАЦИЯ ДАННЫХ
// ======================================================

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeSaveData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};

    const name = String(
        data.profile?.name ||
        data.profile?.username ||
        data.username ||
        data.name ||
        'Оператор'
    ).trim().slice(0, 32);

    const avatar = String(
        data.profile?.avatar ||
        data.avatar ||
        '👷'
    ).trim().slice(0, 50);

    const existingUpgrades = (data.up && typeof data.up === 'object') ? data.up : {};
    const sanitizedUpgrades = {};
    for (const [key, val] of Object.entries(existingUpgrades)) {
        sanitizedUpgrades[key] = safeInteger(val, 0);
    }

    const existingLab = (data.lab && typeof data.lab === 'object') ? data.lab : {};
    const sanitizedLab = {};
    for (const [key, val] of Object.entries(existingLab)) {
        sanitizedLab[key] = safeInteger(val, 0);
    }

    const boost = (data.boost && typeof data.boost === 'object') ? data.boost : {};

    return {
        ...data,
        energy: safeNumber(data.energy),
        cores: safeInteger(data.cores),
        totalProduced: safeNumber(data.totalProduced),
        cityProgress: safeNumber(data.cityProgress),
        cityLevel: safeInteger(data.cityLevel),
        rebirths: safeInteger(data.rebirths),

        up: {
            reactor: 0,
            turbine: 0,
            cooling: 0,
            wires: 0,
            ...sanitizedUpgrades
        },

        lab: {
            p_click: 0,
            p_cps: 0,
            p_city: 0,
            ...sanitizedLab
        },

        boost: {
            activeUntil: safeInteger(boost.activeUntil, 0),
            cooldownUntil: safeInteger(boost.cooldownUntil, 0)
        },

        profile: {
            name: name || 'Оператор',
            avatar: avatar || '👷'
        },

        music: data.music !== undefined ? Boolean(data.music) : true,
        lastSave: Date.now()
    };
}

// ======================================================
// API: СОХРАНЕНИЕ И СИНХРОНИЗАЦИЯ С ТОПОМ
// ======================================================

app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body || {};

    if (!userId || !saveData) {
        return res.status(400).json({ success: false, error: 'Missing userId or saveData' });
    }

    const id = String(userId).trim().slice(0, 255);
    const data = normalizeSaveData(saveData);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            INSERT INTO user_saves (user_id, save_data, updated_at)
            VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id)
            DO UPDATE SET
                save_data = EXCLUDED.save_data,
                updated_at = CURRENT_TIMESTAMP;
        `, [id, JSON.stringify(data)]);

        await client.query(`
            INSERT INTO leaderboard (
                user_id,
                username,
                avatar,
                rebirths,
                energy,
                total_produced,
                city_level,
                city_progress,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                avatar = EXCLUDED.avatar,
                rebirths = EXCLUDED.rebirths,
                energy = EXCLUDED.energy,
                total_produced = EXCLUDED.total_produced,
                city_level = EXCLUDED.city_level,
                city_progress = EXCLUDED.city_progress,
                updated_at = CURRENT_TIMESTAMP;
        `, [
            id,
            data.profile.name,
            data.profile.avatar,
            data.rebirths,
            data.energy,
            data.totalProduced,
            data.cityLevel,
            data.cityProgress
        ]);

        await client.query('COMMIT');
        res.json({ success: true, updatedAt: data.lastSave, data });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('SAVE ERROR:', error);
        res.status(500).json({ success: false, error: 'Database save error' });
    } finally {
        client.release();
    }
});

// ======================================================
// API: ЗАГРУЗКА СОХРАНЕНИЯ
// ======================================================

app.get('/api/save/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).trim().slice(0, 255);
        const result = await pool.query(
            'SELECT save_data, updated_at FROM user_saves WHERE user_id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.json({ success: true, data: null });
        }

        res.json({
            success: true,
            data: result.rows[0].save_data,
            updatedAt: result.rows[0].updated_at
        });
    } catch (error) {
        console.error('LOAD ERROR:', error);
        res.status(500).json({ success: false, error: 'Database load error' });
    }
});

// ======================================================
// API: ЛИДЕРБОРД ИЗ БД
// ======================================================

app.get('/api/leaderboard', async (req, res) => {
    const limit = Math.min(Math.max(safeInteger(req.query.limit, 50), 1), 100);

    try {
        const result = await pool.query(`
            SELECT
                user_id,
                username AS name,
                avatar,
                rebirths,
                energy,
                total_produced AS total,
                city_level,
                city_progress
            FROM leaderboard
            ORDER BY rebirths DESC, energy DESC, updated_at ASC
            LIMIT $1
        `, [limit]);

        const leaderboardWithRank = result.rows.map((row, index) => ({
            rank: index + 1,
            ...row
        }));

        res.json({ success: true, data: leaderboardWithRank });
    } catch (error) {
        console.error('LEADERBOARD ERROR:', error);
        res.status(500).json({ success: false, error: 'Leaderboard load error' });
    }
});

// ======================================================
// API: УДАЛЕНИЕ СВОЕГО ПРОФИЛЯ
// ======================================================

app.delete('/api/save/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).trim().slice(0, 255);
        await pool.query('DELETE FROM user_saves WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM leaderboard WHERE user_id = $1', [userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('DELETE ERROR:', error);
        res.status(500).json({ success: false, error: 'Delete error' });
    }
});

// ======================================================
// API: ПОЛНЫЙ СБРОС ВСЕХ ПРОФИЛЕЙ И ОЧИСТКА БД
// ======================================================

app.post('/api/admin/wipe-database', async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE user_saves, leaderboard RESTART IDENTITY CASCADE;');
        console.log('⚡ All user saves and leaderboard data wiped successfully.');
        res.json({ success: true, message: 'База данных полностью очищена, все профили сброшены.' });
    } catch (error) {
        console.error('WIPE DB ERROR:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// SPA fallback
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) next();
    });
});

async function startServer() {
    await initDB();
    app.listen(PORT, () => {
        console.log(`✓ Server started on port ${PORT}`);
    });
}

startServer();
