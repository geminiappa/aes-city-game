const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ================= POSTGRESQL =================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL error:', err);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= ИНИЦИАЛИЗАЦИЯ БД =================

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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Для уже существующей БД
        await pool.query(`
            ALTER TABLE leaderboard
            ADD COLUMN IF NOT EXISTS avatar VARCHAR(50) DEFAULT '👷';
        `);

        await pool.query(`
            ALTER TABLE leaderboard
            ADD COLUMN IF NOT EXISTS total_produced NUMERIC DEFAULT 0;
        `);

        await pool.query(`
            ALTER TABLE leaderboard
            ALTER COLUMN energy TYPE NUMERIC
            USING energy::numeric;
        `);

        console.log('PostgreSQL database ready');
    } catch (error) {
        console.error('Database initialization error:', error);
        process.exit(1);
    }
}

// ================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =================

function numberOrZero(value) {
    const n = Number(value);

    if (!Number.isFinite(n) || n < 0) {
        return 0;
    }

    return n;
}

function integerOrZero(value) {
    const n = Number(value);

    if (!Number.isFinite(n) || n < 0) {
        return 0;
    }

    return Math.floor(n);
}

function normalizeSaveData(saveData) {
    const data = saveData || {};

    return {
        energy: numberOrZero(data.energy),
        totalProduced: numberOrZero(data.totalProduced),
        cityProgress: numberOrZero(data.cityProgress),
        cityLevel: integerOrZero(data.cityLevel),
        rebirths: integerOrZero(data.rebirths),

        up: {
            reactor: integerOrZero(data.up?.reactor),
            turbine: integerOrZero(data.up?.turbine),
            cooling: integerOrZero(data.up?.cooling),
            wires: integerOrZero(data.up?.wires)
        },

        profile: {
            name: String(data.profile?.name || 'Оператор')
                .trim()
                .slice(0, 32),

            avatar: String(data.profile?.avatar || '👷')
                .slice(0, 50)
        },

        settings: {
            music: data.settings?.music !== false,
            sfx: data.settings?.sfx !== false
        },

        lastSave: Date.now()
    };
}

// ================= SAVE =================

app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body || {};

    if (!userId || !saveData) {
        return res.status(400).json({
            success: false,
            error: 'missing data'
        });
    }

    try {
        const safeUserId = String(userId).slice(0, 255);
        const data = normalizeSaveData(saveData);

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Основное сохранение
            await client.query(`
                INSERT INTO user_saves (
                    user_id,
                    save_data,
                    updated_at
                )
                VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)

                ON CONFLICT (user_id)

                DO UPDATE SET
                    save_data = EXCLUDED.save_data,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                safeUserId,
                JSON.stringify(data)
            ]);

            // Данные для таблицы лидеров
            await client.query(`
                INSERT INTO leaderboard (
                    user_id,
                    username,
                    avatar,
                    rebirths,
                    energy,
                    total_produced,
                    city_level,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    CURRENT_TIMESTAMP
                )

                ON CONFLICT (user_id)

                DO UPDATE SET
                    username = EXCLUDED.username,
                    avatar = EXCLUDED.avatar,
                    rebirths = EXCLUDED.rebirths,
                    energy = EXCLUDED.energy,
                    total_produced = EXCLUDED.total_produced,
                    city_level = EXCLUDED.city_level,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                safeUserId,
                data.profile.name,
                data.profile.avatar,
                data.rebirths,
                data.energy,
                data.totalProduced,
                data.cityLevel
            ]);

            await client.query('COMMIT');

            res.json({
                success: true,
                updatedAt: Date.now()
            });

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Save error:', error);

        res.status(500).json({
            success: false,
            error: 'database save error'
        });
    }
});

// ================= LOAD =================

app.get('/api/save/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).slice(0, 255);

        const result = await pool.query(`
            SELECT
                save_data,
                updated_at
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
        console.error('Load error:', error);

        res.status(500).json({
            success: false,
            error: 'database load error'
        });
    }
});

// ================= DELETE SAVE =================
// Нужно для кнопки "Сбросить прогресс"

app.delete('/api/save/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).slice(0, 255);

        await pool.query(
            'DELETE FROM user_saves WHERE user_id = $1',
            [userId]
        );

        await pool.query(
            'DELETE FROM leaderboard WHERE user_id = $1',
            [userId]
        );

        res.json({
            success: true
        });

    } catch (error) {
        console.error('Delete save error:', error);

        res.status(500).json({
            success: false
        });
    }
});

// ================= LEADERBOARD =================

app.get('/api/leaderboard', async (req, res) => {
    const { sort } = req.query;

    // ВАЖНО: здесь нельзя напрямую вставлять req.query.sort
    // Используем только заранее разрешенные колонки.

    const sortMap = {
        rebirths: 'rebirths',
        energy: 'energy',
        total: 'total_produced'
    };

    const sortColumn = sortMap[sort] || 'rebirths';

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

            ORDER BY ${sortColumn} DESC NULLS LAST,
                     updated_at ASC

            LIMIT 50
        `);

        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Leaderboard error:', error);

        res.status(500).json({
            success: false
        });
    }
});

// ================= PLAYER =================

app.get('/api/player/:id', async (req, res) => {
    try {
        const userId = String(req.params.id).slice(0, 255);

        const result = await pool.query(`
            SELECT
                user_id,
                username AS name,
                avatar,
                rebirths,
                energy,
                total_produced AS total,
                city_level,
                updated_at
            FROM leaderboard
            WHERE user_id = $1
        `, [userId]);

        res.json({
            success: true,
            data: result.rows[0] || null
        });

    } catch (error) {
        console.error('Player data error:', error);

        res.status(500).json({
            success: false
        });
    }
});

// ================= ЗАПУСК =================

async function startServer() {
    await initDB();

    app.listen(PORT, () => {
        console.log(`Server started on port ${PORT}`);
        console.log(`http://localhost:${PORT}`);
    });
}

startServer();
