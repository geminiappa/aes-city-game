try {
    require('dotenv').config();
} catch (e) {
    // dotenv не установлен или не требуется в проде
}

const express = require('express');
const { Pool, types } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Парсинг BIGINT и NUMERIC в числа JS
types.setTypeParser(20, (val) => (val === null ? 0 : Number(val)));
types.setTypeParser(1700, (val) => (val === null ? 0 : Number(val)));

// ======================================================
// АЙДИ АДМИНИСТРАТОРОВ (Иван и Никита)
// ======================================================
const ADMIN_IDS = ['8019907955', '975812111', '820298635'];

// ======================================================
// БАЗА ДАННЫХ POSTGRESQL
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

// Хеширование паролей
function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password).trim()).digest('hex');
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ======================================================
// ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ
// ======================================================
async function initDB() {
    try {
        // Таблица пользователей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(64) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                telegram_id VARCHAR(64),
                role VARCHAR(32) DEFAULT 'player',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Таблица полных сохранений
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves (
                user_id VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                save_data JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Таблица лидеров
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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
            CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON leaderboard(rebirths DESC, energy DESC);
        `);

        console.log('✓ PostgreSQL schema initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
        process.exit(1);
    }
}

// Проверка админских прав
async function checkIsAdmin(userId) {
    if (!userId) return false;
    const strId = String(userId).trim();
    if (ADMIN_IDS.includes(strId)) return true;

    const res = await pool.query('SELECT telegram_id, role FROM users WHERE id = $1', [strId]);
    if (res.rows.length > 0) {
        const row = res.rows[0];
        if (row.role === 'admin' || ADMIN_IDS.includes(String(row.telegram_id))) {
            return true;
        }
    }
    return false;
}

function normalizeSaveData(raw, username = 'Оператор', avatar = '👷') {
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
        ...data,
        energy: Math.max(0, Number(data.energy) || 0),
        cores: Math.max(0, Math.floor(Number(data.cores) || 0)),
        totalProduced: Math.max(0, Number(data.totalProduced) || 0),
        cityProgress: Math.max(0, Number(data.cityProgress) || 0),
        cityLevel: Math.max(0, Math.floor(Number(data.cityLevel) || 0)),
        rebirths: Math.max(0, Math.floor(Number(data.rebirths) || 0)),
        up: {
            reactor: 0,
            turbine: 0,
            cooling: 0,
            wires: 0,
            ...(data.up || {})
        },
        lab: {
            p_click: 0,
            p_cps: 0,
            p_city: 0,
            ...(data.lab || {})
        },
        boost: {
            activeUntil: Number(data.boost?.activeUntil) || 0,
            cooldownUntil: Number(data.boost?.cooldownUntil) || 0
        },
        profile: {
            name: String(data.profile?.name || username).slice(0, 32),
            avatar: String(data.profile?.avatar || avatar).slice(0, 10)
        },
        music: data.music !== undefined ? Boolean(data.music) : true,
        lastSave: Date.now()
    };
}

// ======================================================
// АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ
// ======================================================

// Регистрация аккаунта
app.post('/api/auth/register', async (req, res) => {
    const { username, password, telegramId, avatar } = req.body || {};

    const cleanUser = String(username || '').trim().slice(0, 32);
    const cleanPass = String(password || '').trim();
    const cleanTgId = telegramId ? String(telegramId).trim() : null;
    const cleanAvatar = avatar ? String(avatar).trim() : '👷';

    if (!cleanUser || cleanUser.length < 3) {
        return res.status(400).json({ success: false, error: 'Имя пользователя должно быть не короче 3 символов' });
    }
    if (!cleanPass || cleanPass.length < 4) {
        return res.status(400).json({ success: false, error: 'Пароль должен быть не менее 4 символов' });
    }

    try {
        const exist = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [cleanUser]);
        if (exist.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Этот никнейм уже занят другим игроком' });
        }

        const userId = 'u_' + crypto.randomBytes(8).toString('hex');
        const passHash = hashPassword(cleanPass);
        const isAdmin = cleanTgId && ADMIN_IDS.includes(cleanTgId);
        const role = isAdmin ? 'admin' : 'player';

        await pool.query(`
            INSERT INTO users (id, username, password_hash, telegram_id, role)
            VALUES ($1, $2, $3, $4, $5)
        `, [userId, cleanUser, passHash, cleanTgId, role]);

        // Создаем начальный сейв
        const initialSave = normalizeSaveData({}, cleanUser, cleanAvatar);
        await pool.query(`
            INSERT INTO user_saves (user_id, save_data) VALUES ($1, $2::jsonb)
        `, [userId, JSON.stringify(initialSave)]);

        // Заносим в лидерборд
        await pool.query(`
            INSERT INTO leaderboard (user_id, username, avatar, rebirths, energy, total_produced, city_level, city_progress)
            VALUES ($1, $2, $3, 0, 0, 0, 0, 0)
        `, [userId, cleanUser, cleanAvatar]);

        res.json({
            success: true,
            user: {
                id: userId,
                username: cleanUser,
                avatar: cleanAvatar,
                telegramId: cleanTgId,
                role,
                isAdmin: role === 'admin'
            },
            saveData: initialSave
        });
    } catch (err) {
        console.error('REGISTER ERROR:', err);
        res.status(500).json({ success: false, error: 'Ошибка регистрации аккаунта' });
    }
});

// Вход в аккаунт по нику
app.post('/api/auth/login', async (req, res) => {
    const { username, password, telegramId } = req.body || {};

    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();
    const cleanTgId = telegramId ? String(telegramId).trim() : null;

    if (!cleanUser || !cleanPass) {
        return res.status(400).json({ success: false, error: 'Заполните никнейм и пароль' });
    }

    try {
        const passHash = hashPassword(cleanPass);
        const userRes = await pool.query(
            'SELECT id, username, telegram_id, role, password_hash FROM users WHERE LOWER(username) = LOWER($1)',
            [cleanUser]
        );

        if (userRes.rows.length === 0 || userRes.rows[0].password_hash !== passHash) {
            return res.status(401).json({ success: false, error: 'Неверный никнейм или пароль' });
        }

        const user = userRes.rows[0];

        // Проверка привязки ТГ или выдача прав админа
        let role = user.role;
        let tgId = user.telegram_id;

        if (cleanTgId) {
            tgId = cleanTgId;
            if (ADMIN_IDS.includes(cleanTgId)) {
                role = 'admin';
            }
            await pool.query('UPDATE users SET telegram_id = $1, role = $2 WHERE id = $3', [tgId, role, user.id]);
        } else if (tgId && ADMIN_IDS.includes(tgId)) {
            role = 'admin';
        }

        // Загрузка сейва
        const saveRes = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [user.id]);
        let saveData = null;
        if (saveRes.rows.length > 0) {
            saveData = saveRes.rows[0].save_data;
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                avatar: saveData?.profile?.avatar || '👷',
                telegramId: tgId,
                role,
                isAdmin: role === 'admin'
            },
            saveData
        });
    } catch (err) {
        console.error('LOGIN ERROR:', err);
        res.status(500).json({ success: false, error: 'Ошибка входа' });
    }
});

// ======================================================
// ИГРОВЫЕ СОХРАНЕНИЯ И ЛИДЕРБОРД
// ======================================================

app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body || {};
    if (!userId || !saveData) {
        return res.status(400).json({ success: false, error: 'Missing userId or saveData' });
    }

    const id = String(userId).trim();
    const data = normalizeSaveData(saveData);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            INSERT INTO user_saves (user_id, save_data, updated_at)
            VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id)
            DO UPDATE SET save_data = EXCLUDED.save_data, updated_at = CURRENT_TIMESTAMP;
        `, [id, JSON.stringify(data)]);

        await client.query(`
            INSERT INTO leaderboard (user_id, username, avatar, rebirths, energy, total_produced, city_level, city_progress, updated_at)
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
        res.json({ success: true, updatedAt: data.lastSave });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('SAVE ERROR:', err);
        res.status(500).json({ success: false, error: 'Ошибка сохранения' });
    } finally {
        client.release();
    }
});

app.get('/api/save/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).trim();
        const result = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [userId]);

        if (result.rows.length === 0) return res.json({ success: true, data: null });
        res.json({ success: true, data: result.rows[0].save_data });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка загрузки сейва' });
    }
});

// Таблица лидеров из PostgreSQL
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                user_id,
                username AS name,
                avatar,
                rebirths,
                energy,
                total_produced AS total,
                city_level
            FROM leaderboard
            ORDER BY rebirths DESC, energy DESC, updated_at ASC
            LIMIT 50
        `);

        const ranked = result.rows.map((row, index) => ({ rank: index + 1, ...row }));
        res.json({ success: true, data: ranked });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка загрузки лидеров' });
    }
});

// ======================================================
// АДМИН ПАНЕЛЬ (API)
// ======================================================

// Проверка статуса админа
app.post('/api/admin/check', async (req, res) => {
    const { userId } = req.body || {};
    const isAdmin = await checkIsAdmin(userId);
    res.json({ success: true, isAdmin });
});

// Список игроков для админки
app.post('/api/admin/users', async (req, res) => {
    const { adminId } = req.body || {};
    if (!(await checkIsAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.telegram_id, u.role, u.created_at,
                   l.rebirths, l.energy, l.city_level
            FROM users u
            LEFT JOIN leaderboard l ON u.id = l.user_id
            ORDER BY u.created_at DESC
        `);
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Накрутка / Выдача ресурсов игроку
app.post('/api/admin/give', async (req, res) => {
    const { adminId, targetUserId, energy, cores, rebirths } = req.body || {};
    if (!(await checkIsAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        const saveRes = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [targetUserId]);
        if (saveRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Игрок не найден' });
        }

        const data = saveRes.rows[0].save_data;
        if (energy !== undefined) data.energy = Math.max(0, (data.energy || 0) + Number(energy));
        if (cores !== undefined) data.cores = Math.max(0, (data.cores || 0) + Number(cores));
        if (rebirths !== undefined) data.rebirths = Math.max(0, (data.rebirths || 0) + Number(rebirths));

        await pool.query('UPDATE user_saves SET save_data = $1::jsonb WHERE user_id = $2', [JSON.stringify(data), targetUserId]);
        await pool.query(`
            UPDATE leaderboard
            SET energy = $1, rebirths = $2
            WHERE user_id = $3
        `, [data.energy, data.rebirths, targetUserId]);

        res.json({ success: true, message: 'Ресурсы успешно выданы', updated: { energy: data.energy, cores: data.cores, rebirths: data.rebirths } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Полная очистка БД (Всей базы данных)
app.post('/api/admin/wipe-database', async (req, res) => {
    const { adminId } = req.body || {};
    if (!(await checkIsAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        // Очистка сохранений и лидерборда
        await pool.query('TRUNCATE TABLE leaderboard, user_saves RESTART IDENTITY CASCADE;');
        res.json({ success: true, message: 'Все сохранения и лидерборд базы данных успешно очищены' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Сброс только таблицы лидеров
app.post('/api/admin/reset-leaderboard', async (req, res) => {
    const { adminId } = req.body || {};
    if (!(await checkIsAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        await pool.query('TRUNCATE TABLE leaderboard RESTART IDENTITY CASCADE;');
        res.json({ success: true, message: 'Таблица лидеров успешно сброшена' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Удаление конкретного пользователя
app.post('/api/admin/delete-user', async (req, res) => {
    const { adminId, targetUserId } = req.body || {};
    if (!(await checkIsAdmin(adminId))) {
        return res.status(403).json({ success: false, error: 'Доступ запрещен' });
    }

    try {
        await pool.query('DELETE FROM users WHERE id = $1', [targetUserId]);
        res.json({ success: true, message: 'Пользователь удален' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
        console.log(`✓ Server running at http://localhost:${PORT}`);
        console.log(`✓ Admins whitelist: ${ADMIN_IDS.join(', ')}`);
    });
}

startServer();
