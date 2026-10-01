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

// Парсинг BIGINT (20) и NUMERIC (1700) в JS Number, чтобы база не возвращала числа как строки
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
// MIDDLEWARE (CORS, JSON, STATIC)
// ======================================================

// Разрешение CORS для работы с Telegram WebApp, мобильных браузеров и локального тестирования
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
        // Основная таблица полного сохранения игрока
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves (
                user_id VARCHAR(255) PRIMARY KEY,
                save_data JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Таблица лидеров и профилей
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

        // Миграции структуры для существующих таблиц
        await pool.query(`
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS avatar VARCHAR(50) DEFAULT '👷';
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS total_produced NUMERIC DEFAULT 0;
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS city_level INT DEFAULT 0;
            ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS city_progress NUMERIC DEFAULT 0;
            ALTER TABLE leaderboard ALTER COLUMN energy TYPE NUMERIC USING energy::numeric;
            ALTER TABLE leaderboard ALTER COLUMN total_produced TYPE NUMERIC USING total_produced::numeric;
        `);

        // Индексы для быстрого лидерборда
        await pool.query(`
            CREATE INDEX IF NOT EXISTS leaderboard_rebirths_idx ON leaderboard(rebirths DESC);
            CREATE INDEX IF NOT EXISTS leaderboard_energy_idx ON leaderboard(energy DESC);
            CREATE INDEX IF NOT EXISTS leaderboard_total_idx ON leaderboard(total_produced DESC);
            CREATE INDEX IF NOT EXISTS leaderboard_city_idx ON leaderboard(city_level DESC, city_progress DESC);
        `);

        console.log('✓ PostgreSQL schema initialized & synchronized');
    } catch (error) {
        console.error('Database initialization error:', error);
        process.exit(1);
    }
}

// ======================================================
// ВАЛИДАЦИЯ И СИНХРОНИЗАЦИЯ ДАННЫХ
// ======================================================

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/**
 * Нормализует сохранение: проверяет критические поля,
 * объединяет настройки профиля и музыки как из вложенных, так и из плоских структур,
 * сохраняя при этом все кастомные улучшения и достижения игрока.
 */
function normalizeSaveData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};

    // Извлечение имени и аватара (поддерживает profile.name, username, name)
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

    // Извлечение настроек музыки и звука
    const musicEnabled = data.settings?.music !== undefined
        ? Boolean(data.settings.music)
        : (data.music !== undefined ? Boolean(data.music) : true);

    const sfxEnabled = data.settings?.sfx !== undefined
        ? Boolean(data.settings.sfx)
        : (data.sfx !== undefined ? Boolean(data.sfx) : true);

    const musicVolume = safeNumber(
        data.settings?.musicVolume ?? data.musicVolume ?? data.settings?.volume,
        0.8
    );

    const sfxVolume = safeNumber(
        data.settings?.sfxVolume ?? data.sfxVolume,
        1.0
    );

    const currentTrack = safeInteger(
        data.settings?.currentTrack ?? data.currentTrack,
        0
    );

    // Сохраняем все улучшения без удаления неизвестных ключей
    const existingUpgrades = (data.up && typeof data.up === 'object') ? data.up : {};
    const sanitizedUpgrades = {};
    for (const [key, val] of Object.entries(existingUpgrades)) {
        sanitizedUpgrades[key] = safeInteger(val, 0);
    }

    return {
        ...data,
        energy: safeNumber(data.energy),
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

        profile: {
            name: name || 'Оператор',
            avatar: avatar || '👷'
        },

        settings: {
            music: musicEnabled,
            sfx: sfxEnabled,
            musicVolume: Math.min(1, Math.max(0, musicVolume)),
            sfxVolume: Math.min(1, Math.max(0, sfxVolume)),
            currentTrack: currentTrack
        },

        lastSave: Date.now()
    };
}

// ======================================================
// API: ПОЛНОЕ СОХРАНЕНИЕ (ИГРА + ПРОФИЛЬ + НАСТРОЙКИ)
// ======================================================

app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body || {};

    if (!userId || !saveData) {
        return res.status(400).json({
            success: false,
            error: 'Missing userId or saveData'
        });
    }

    const id = String(userId).trim().slice(0, 255);
    const data = normalizeSaveData(saveData);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Полный дамп в JSONB
        await client.query(`
            INSERT INTO user_saves (user_id, save_data, updated_at)
            VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id)
            DO UPDATE SET
                save_data = EXCLUDED.save_data,
                updated_at = CURRENT_TIMESTAMP;
        `, [id, JSON.stringify(data)]);

        // 2. Синхронизация профиля и прогресса с лидербордом
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

        res.json({
            success: true,
            updatedAt: data.lastSave,
            data
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rbErr) {
            console.error('Rollback error:', rbErr);
        }

        console.error('SAVE ERROR:', error);
        res.status(500).json({
            success: false,
            error: 'Database save error'
        });
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

        const result = await pool.query(`
            SELECT save_data, updated_at
            FROM user_saves
            WHERE user_id = $1
        `, [userId]);

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                data: null
            });
        }

        res.json({
            success: true,
            data: result.rows[0].save_data,
            updatedAt: result.rows[0].updated_at
        });
    } catch (error) {
        console.error('LOAD ERROR:', error);
        res.status(500).json({
            success: false,
            error: 'Database load error'
        });
    }
});

// ======================================================
// API: СИНХРОНИЗАЦИЯ ТОЛЬКО ПРОФИЛЯ
// ======================================================

app.post('/api/profile', async (req, res) => {
    const { userId, name, avatar } = req.body || {};

    if (!userId) {
        return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const id = String(userId).trim().slice(0, 255);
    const cleanName = String(name || 'Оператор').trim().slice(0, 32);
    const cleanAvatar = String(avatar || '👷').trim().slice(0, 50);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Обновляем в лидерборде
        await client.query(`
            INSERT INTO leaderboard (user_id, username, avatar, updated_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                avatar = EXCLUDED.avatar,
                updated_at = CURRENT_TIMESTAMP;
        `, [id, cleanName, cleanAvatar]);

        // Обновляем внутри JSON сохранения
        await client.query(`
            UPDATE user_saves
            SET save_data = jsonb_set(
                jsonb_set(save_data, '{profile,name}', to_jsonb($2::text)),
                '{profile,avatar}', to_jsonb($3::text)
            ),
            updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1;
        `, [id, cleanName, cleanAvatar]);

        await client.query('COMMIT');

        res.json({
            success: true,
            profile: { name: cleanName, avatar: cleanAvatar }
        });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('PROFILE UPDATE ERROR:', error);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    } finally {
        client.release();
    }
});

// ======================================================
// API: СИНХРОНИЗАЦИЯ НАСТРОЕК (МУЗЫКА И ЗВУКИ)
// ======================================================

app.post('/api/settings', async (req, res) => {
    const { userId, settings } = req.body || {};

    if (!userId || !settings) {
        return res.status(400).json({ success: false, error: 'Missing userId or settings' });
    }

    const id = String(userId).trim().slice(0, 255);

    try {
        const currentSave = await pool.query(
            'SELECT save_data FROM user_saves WHERE user_id = $1',
            [id]
        );

        if (currentSave.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Save not found' });
        }

        const saveData = currentSave.rows[0].save_data;
        saveData.settings = {
            ...saveData.settings,
            music: settings.music !== undefined ? Boolean(settings.music) : saveData.settings?.music ?? true,
            sfx: settings.sfx !== undefined ? Boolean(settings.sfx) : saveData.settings?.sfx ?? true,
            musicVolume: safeNumber(settings.musicVolume ?? settings.volume ?? saveData.settings?.musicVolume, 0.8),
            sfxVolume: safeNumber(settings.sfxVolume ?? saveData.settings?.sfxVolume, 1.0),
            currentTrack: safeInteger(settings.currentTrack ?? saveData.settings?.currentTrack, 0)
        };

        await pool.query(`
            UPDATE user_saves
            SET save_data = $2::jsonb, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
        `, [id, JSON.stringify(saveData)]);

        res.json({
            success: true,
            settings: saveData.settings
        });
    } catch (error) {
        console.error('SETTINGS UPDATE ERROR:', error);
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
});

// ======================================================
// API: ЛИДЕРБОРД
// ======================================================

app.get('/api/leaderboard', async (req, res) => {
    const sortMap = {
        rebirths: 'rebirths',
        energy: 'energy',
        total: 'total_produced',
        city: 'city_level'
    };

    const sortColumn = sortMap[req.query.sort] || 'rebirths';
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
            ORDER BY ${sortColumn} DESC NULLS LAST, updated_at ASC
            LIMIT $1
        `, [limit]);

        // Присваиваем ранг каждому игроку в выборке
        const leaderboardWithRank = result.rows.map((row, index) => ({
            rank: index + 1,
            ...row
        }));

        res.json({
            success: true,
            data: leaderboardWithRank
        });
    } catch (error) {
        console.error('LEADERBOARD ERROR:', error);
        res.status(500).json({
            success: false,
            error: 'Leaderboard load error'
        });
    }
});

// ======================================================
// API: ИНФОРМАЦИЯ ОБ ИГРОКЕ И ЕГО РАНГ
// ======================================================

app.get('/api/player/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).trim().slice(0, 255);

        const result = await pool.query(`
            WITH ranked AS (
                SELECT
                    user_id,
                    username AS name,
                    avatar,
                    rebirths,
                    energy,
                    total_produced AS total,
                    city_level,
                    city_progress,
                    updated_at,
                    RANK() OVER (ORDER BY rebirths DESC, total_produced DESC) AS rank
                FROM leaderboard
            )
            SELECT * FROM ranked WHERE user_id = $1
        `, [userId]);

        res.json({
            success: true,
            data: result.rows[0] || null
        });
    } catch (error) {
        console.error('PLAYER ERROR:', error);
        res.status(500).json({
            success: false,
            error: 'Player load error'
        });
    }
});

// ======================================================
// API: УДАЛЕНИЕ СОХРАНЕНИЯ
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
// HEALTHCHECK
// ======================================================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'error', db: err.message });
    }
});

// SPA fallback для раздачи index.html при прямых переходах
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) next();
    });
});

// ======================================================
// СТАРТ СЕРВЕРА
// ======================================================

async function startServer() {
    await initDB();

    app.listen(PORT, () => {
        console.log(`✓ Server started on port ${PORT}`);
        console.log(`✓ Local URL: http://localhost:${PORT}`);
    });
}

startServer();
