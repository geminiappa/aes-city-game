try {
    require('dotenv').config();
} catch (e) {}

const express = require('express');
const { Pool, types } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

types.setTypeParser(20, (val) => (val === null ? 0 : Number(val)));
types.setTypeParser(1700, (val) => (val === null ? 0 : Number(val)));

// ======================================================
// АЙДИ АДМИНИСТРАТОРОВ
// ======================================================
const SUPER_ADMIN_ID = '8019907955'; // Иван (Главный создатель, нельзя уволить)
const INITIAL_ADMIN_IDS = ['8019907955', '975812111', '820298635']; // Иван и Никита

// Жесткие лимиты на выдачу ресурсов
const ADMIN_LIMITS = {
    MAX_ENERGY: 1_000_000_000,
    MAX_CORES: 50_000,
    MAX_REBIRTHS: 50
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/game_db',
    ssl: process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL?.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
});

pool.on('error', (err) => console.error('PostgreSQL error:', err));

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password).trim()).digest('hex');
}

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
// ИНИЦИАЛИЗАЦИЯ БД
// ======================================================
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(64) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                telegram_id VARCHAR(64),
                role VARCHAR(32) DEFAULT 'player',
                is_banned BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Миграция если колонка is_banned отсутствует
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) DEFAULT 'player';
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves (
                user_id VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                save_data JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

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

        console.log('✓ PostgreSQL schema initialized');
    } catch (error) {
        console.error('Init DB error:', error);
        process.exit(1);
    }
}

// Проверка админ-прав
async function getAdminStatus(userId) {
    if (!userId) return { isAdmin: false, isSuper: false };
    const strId = String(userId).trim();

    const res = await pool.query('SELECT id, telegram_id, role, is_banned FROM users WHERE id = $1', [strId]);
    if (res.rows.length === 0) {
        if (INITIAL_ADMIN_IDS.includes(strId)) {
            return { isAdmin: true, isSuper: strId === SUPER_ADMIN_ID };
        }
        return { isAdmin: false, isSuper: false };
    }

    const u = res.rows[0];
    if (u.is_banned || u.role === 'fired') {
        return { isAdmin: false, isSuper: false }; // Уволенные админы теряют доступ
    }

    const isSuper = String(u.telegram_id) === SUPER_ADMIN_ID;
    if (isSuper || u.role === 'admin' || (INITIAL_ADMIN_IDS.includes(String(u.telegram_id)) && u.role !== 'fired')) {
        return { isAdmin: true, isSuper };
    }

    return { isAdmin: false, isSuper: false };
}

function normalizeSaveData(raw, username = 'Оператор', avatar = '👷') {
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
        ...data,
        energy: Math.max(0, Number(data.energy) || 0),
        cores: Math.max(0, Math.floor(Number(data.cores) || 0)),
        totalProduced: Math.max(0, Number(data.totalProduced) || 0),
        cityProgress: Math.max(0, Number(data.cityProgress) || 0),
        cityLevel: Math.max(0, Math.min(20, Math.floor(Number(data.cityLevel) || 0))),
        rebirths: Math.max(0, Math.floor(Number(data.rebirths) || 0)),
        up: { reactor: 0, turbine: 0, cooling: 0, wires: 0, ...(data.up || {}) },
        lab: { p_click: 0, p_cps: 0, p_city: 0, ...(data.lab || {}) },
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
// АВТОРИЗАЦИЯ
// ======================================================

app.post('/api/auth/register', async (req, res) => {
    const { username, password, telegramId, avatar } = req.body || {};
    const cleanUser = String(username || '').trim().slice(0, 32);
    const cleanPass = String(password || '').trim();
    const cleanTgId = telegramId ? String(telegramId).trim() : null;
    const cleanAvatar = avatar ? String(avatar).trim() : '👷';

    if (!cleanUser || cleanUser.length < 3) return res.status(400).json({ success: false, error: 'Никнейм от 3 символов' });
    if (!cleanPass || cleanPass.length < 4) return res.status(400).json({ success: false, error: 'Пароль от 4 символов' });

    try {
        const exist = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [cleanUser]);
        if (exist.rows.length > 0) return res.status(400).json({ success: false, error: 'Этот ник уже занят' });

        const userId = 'u_' + crypto.randomBytes(8).toString('hex');
        const passHash = hashPassword(cleanPass);
        const isAdmin = cleanTgId && INITIAL_ADMIN_IDS.includes(cleanTgId);
        const role = isAdmin ? 'admin' : 'player';

        await pool.query(`
            INSERT INTO users (id, username, password_hash, telegram_id, role)
            VALUES ($1, $2, $3, $4, $5)
        `, [userId, cleanUser, passHash, cleanTgId, role]);

        const initialSave = normalizeSaveData({}, cleanUser, cleanAvatar);
        await pool.query('INSERT INTO user_saves (user_id, save_data) VALUES ($1, $2::jsonb)', [userId, JSON.stringify(initialSave)]);
        await pool.query('INSERT INTO leaderboard (user_id, username, avatar) VALUES ($1, $2, $3)', [userId, cleanUser, cleanAvatar]);

        res.json({
            success: true,
            user: {
                id: userId,
                username: cleanUser,
                avatar: cleanAvatar,
                telegramId: cleanTgId,
                role,
                isAdmin: role === 'admin',
                isSuper: cleanTgId === SUPER_ADMIN_ID
            },
            saveData: initialSave
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка регистрации' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password, telegramId } = req.body || {};
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();
    const cleanTgId = telegramId ? String(telegramId).trim() : null;

    try {
        const passHash = hashPassword(cleanPass);
        const userRes = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [cleanUser]);

        if (userRes.rows.length === 0 || userRes.rows[0].password_hash !== passHash) {
            return res.status(401).json({ success: false, error: 'Неверный ник или пароль' });
        }

        const user = userRes.rows[0];
        if (user.is_banned) {
            return res.status(403).json({ success: false, error: '🚫 Ваш аккаунт заблокирован администратором' });
        }

        let role = user.role;
        let tgId = user.telegram_id;

        // Если не был уволен и совпадает айди админа
        if (cleanTgId) {
            tgId = cleanTgId;
            if (INITIAL_ADMIN_IDS.includes(cleanTgId) && role !== 'fired') role = 'admin';
            await pool.query('UPDATE users SET telegram_id = $1, role = $2 WHERE id = $3', [tgId, role, user.id]);
        }

        const saveRes = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [user.id]);
        const saveData = saveRes.rows[0]?.save_data || null;

        const adminStatus = await getAdminStatus(user.id);

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                avatar: saveData?.profile?.avatar || '👷',
                telegramId: tgId,
                role,
                isAdmin: adminStatus.isAdmin,
                isSuper: adminStatus.isSuper
            },
            saveData
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка входа' });
    }
});

// ======================================================
// СОХРАНЕНИЯ И ЛИДЕРБОРД
// ======================================================

app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body || {};
    if (!userId || !saveData) return res.status(400).json({ success: false, error: 'Invalid data' });

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
        `, [id, data.profile.name, data.profile.avatar, data.rebirths, data.energy, data.totalProduced, data.cityLevel, data.cityProgress]);

        await client.query('COMMIT');
        res.json({ success: true, updatedAt: data.lastSave });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ success: false, error: 'Save error' });
    } finally {
        client.release();
    }
});

app.get('/api/save/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [String(req.params.id).trim()]);
        res.json({ success: true, data: result.rows[0]?.save_data || null });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Load error' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT user_id, username AS name, avatar, rebirths, energy, city_level
            FROM leaderboard
            ORDER BY rebirths DESC, energy DESC
            LIMIT 50
        `);
        const ranked = result.rows.map((r, i) => ({ rank: i + 1, ...r }));
        res.json({ success: true, data: ranked });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Leaderboard error' });
    }
});

// ======================================================
// АДМИН ПАНЕЛЬ: ЗАЩИТА, ЛИМИТЫ, УВОЛЬНЕНИЕ
// ======================================================

// Список пользователей
app.post('/api/admin/users', async (req, res) => {
    const { adminId } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.telegram_id, u.role, u.is_banned,
                   COALESCE(l.rebirths, 0) as rebirths,
                   COALESCE(l.energy, 0) as energy,
                   COALESCE(l.city_level, 0) as city_level
            FROM users u
            LEFT JOIN leaderboard l ON u.id = l.user_id
            ORDER BY u.created_at DESC
        `);
        res.json({ success: true, users: result.rows, isSuper: status.isSuper });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Выдача ресурсов С ОГРАНИЧЕНИЯМИ
app.post('/api/admin/give', async (req, res) => {
    const { adminId, targetUserId, energy, cores, rebirths } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    // Валидация лимитов
    const addEnergy = Math.max(0, Math.min(Number(energy) || 0, ADMIN_LIMITS.MAX_ENERGY));
    const addCores = Math.max(0, Math.min(Number(cores) || 0, ADMIN_LIMITS.MAX_CORES));
    const addRebirths = Math.max(0, Math.min(Number(rebirths) || 0, ADMIN_LIMITS.MAX_REBIRTHS));

    try {
        const saveRes = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [targetUserId]);
        if (saveRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Игрок не найден' });

        const data = saveRes.rows[0].save_data;
        data.energy = (data.energy || 0) + addEnergy;
        data.cores = (data.cores || 0) + addCores;
        data.rebirths = (data.rebirths || 0) + addRebirths;

        await pool.query('UPDATE user_saves SET save_data = $1::jsonb WHERE user_id = $2', [JSON.stringify(data), targetUserId]);
        await pool.query('UPDATE leaderboard SET energy = $1, rebirths = $2 WHERE user_id = $3', [data.energy, data.rebirths, targetUserId]);

        res.json({
            success: true,
            message: `Выдано: +${addEnergy} ⚡, +${addCores} 💎, +${addRebirths} ☢️`,
            updated: { energy: data.energy, cores: data.cores, rebirths: data.rebirths }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// УВОЛЬНЕНИЕ АДМИНА
app.post('/api/admin/fire', async (req, res) => {
    const { adminId, targetUserId } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    try {
        const targetRes = await pool.query('SELECT telegram_id, role, username FROM users WHERE id = $1', [targetUserId]);
        if (targetRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        const target = targetRes.rows[0];

        // Нельзя уволить Главного создателя Ивана
        if (String(target.telegram_id) === SUPER_ADMIN_ID) {
            return res.status(400).json({ success: false, error: 'Нельзя уволить Главного Инженера (Ивана)!' });
        }

        // Устанавливаем статус 'fired' (уволен из админов)
        await pool.query("UPDATE users SET role = 'fired' WHERE id = $1", [targetUserId]);
        res.json({ success: true, message: `Администратор ${target.username} успешно уволен и разжалован в рабочие!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// БАН / РАЗБАН
app.post('/api/admin/toggle-ban', async (req, res) => {
    const { adminId, targetUserId } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    try {
        const targetRes = await pool.query('SELECT telegram_id, is_banned, username FROM users WHERE id = $1', [targetUserId]);
        if (targetRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Игрок не найден' });
        const target = targetRes.rows[0];

        if (String(target.telegram_id) === SUPER_ADMIN_ID) {
            return res.status(400).json({ success: false, error: 'Нельзя забанить Главного Инженера!' });
        }

        const newBan = !target.is_banned;
        await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [newBan, targetUserId]);
        res.json({ success: true, message: `Статус игрока ${target.username}: ${newBan ? 'ЗАБАНЕН 🚫' : 'РАЗБАНЕН ✅'}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// СБРОС ИГРОКА (ОБНУЛЕНИЕ)
app.post('/api/admin/reset-user', async (req, res) => {
    const { adminId, targetUserId } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    try {
        const u = await pool.query('SELECT username FROM users WHERE id = $1', [targetUserId]);
        const initial = normalizeSaveData({}, u.rows[0]?.username || 'Оператор');
        await pool.query('UPDATE user_saves SET save_data = $1::jsonb WHERE user_id = $2', [JSON.stringify(initial), targetUserId]);
        await pool.query('UPDATE leaderboard SET energy = 0, rebirths = 0, city_level = 0, total_produced = 0 WHERE user_id = $1', [targetUserId]);
        res.json({ success: true, message: 'Прогресс игрока полностью обнулен' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ОЧИСТКА ВСЕЙ БД
app.post('/api/admin/wipe-database', async (req, res) => {
    const { adminId } = req.body || {};
    const status = await getAdminStatus(adminId);
    if (!status.isAdmin) return res.status(403).json({ success: false, error: 'Доступ запрещен' });

    try {
        await pool.query('TRUNCATE TABLE leaderboard, user_saves RESTART IDENTITY CASCADE;');
        res.json({ success: true, message: 'База данных полностью очищена' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) next();
    });
});

async function startServer() {
    await initDB();
    app.listen(PORT, () => console.log(`✓ Server running at http://localhost:${PORT}`));
}

startServer();
