const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// POSTGRESQL
// ======================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
});

// ======================================================
// EXPRESS
// ======================================================

app.use(express.json({
    limit: '5mb'
}));

app.use(express.static(
    path.join(__dirname, 'public')
));

// ======================================================
// ИНИЦИАЛИЗАЦИЯ БАЗЫ
// ======================================================

async function initDB() {
    try {

        // --------------------------------------------------
        // Основное сохранение игры
        // --------------------------------------------------

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves (
                user_id VARCHAR(255) PRIMARY KEY,

                save_data JSONB NOT NULL,

                updated_at TIMESTAMP
                    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --------------------------------------------------
        // Таблица лидеров
        // --------------------------------------------------

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id VARCHAR(255) PRIMARY KEY,

                username VARCHAR(255)
                    DEFAULT 'Оператор',

                avatar VARCHAR(50)
                    DEFAULT '👷',

                rebirths BIGINT
                    DEFAULT 0,

                energy NUMERIC
                    DEFAULT 0,

                total_produced NUMERIC
                    DEFAULT 0,

                city_level INT
                    DEFAULT 0,

                updated_at TIMESTAMP
                    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --------------------------------------------------
        // Обновление старой структуры БД
        // --------------------------------------------------

        await pool.query(`
            ALTER TABLE leaderboard
            ADD COLUMN IF NOT EXISTS avatar
            VARCHAR(50)
            DEFAULT '👷';
        `);

        await pool.query(`
            ALTER TABLE leaderboard
            ADD COLUMN IF NOT EXISTS total_produced
            NUMERIC
            DEFAULT 0;
        `);

        await pool.query(`
            ALTER TABLE leaderboard
            ADD COLUMN IF NOT EXISTS city_level
            INT
            DEFAULT 0;
        `);

        // Если раньше energy был BIGINT
        await pool.query(`
            ALTER TABLE leaderboard
            ALTER COLUMN energy TYPE NUMERIC
            USING energy::numeric;
        `);

        // Индексы
        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            leaderboard_rebirths_idx
            ON leaderboard(rebirths DESC);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            leaderboard_energy_idx
            ON leaderboard(energy DESC);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            leaderboard_total_idx
            ON leaderboard(total_produced DESC);
        `);

        console.log('=================================');
        console.log('PostgreSQL database ready');
        console.log('=================================');

    } catch (error) {

        console.error(
            'Database initialization error:',
            error
        );

        process.exit(1);
    }
}

// ======================================================
// НОРМАЛИЗАЦИЯ ДАННЫХ
// ======================================================

function safeNumber(value) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    if (number < 0) {
        return 0;
    }

    return number;
}

function safeInteger(value) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    if (number < 0) {
        return 0;
    }

    return Math.floor(number);
}

function normalizeSaveData(data) {

    data = data || {};

    return {

        // ==============================================
        // ЭНЕРГИЯ
        // ==============================================

        energy: safeNumber(
            data.energy
        ),

        // ==============================================
        // ОБЩАЯ ПРОИЗВОДСТВЕННАЯ СТАТИСТИКА
        // ==============================================

        totalProduced: safeNumber(
            data.totalProduced
        ),

        cityProgress: safeNumber(
            data.cityProgress
        ),

        cityLevel: safeInteger(
            data.cityLevel
        ),

        // ==============================================
        // РЕБИРТЫ
        // ==============================================

        rebirths: safeInteger(
            data.rebirths
        ),

        // ==============================================
        // УЛУЧШЕНИЯ
        // ==============================================

        up: {

            reactor: safeInteger(
                data.up?.reactor
            ),

            turbine: safeInteger(
                data.up?.turbine
            ),

            cooling: safeInteger(
                data.up?.cooling
            ),

            wires: safeInteger(
                data.up?.wires
            )
        },

        // ==============================================
        // ПРОФИЛЬ
        // ==============================================

        profile: {

            name: String(
                data.profile?.name || 'Оператор'
            )
                .trim()
                .slice(0, 32),

            avatar: String(
                data.profile?.avatar || '👷'
            )
                .slice(0, 50)
        },

        // ==============================================
        // НАСТРОЙКИ
        // ==============================================

        settings: {

            music:
                data.settings?.music !== false,

            sfx:
                data.settings?.sfx !== false
        },

        lastSave: Date.now()
    };
}

// ======================================================
// SAVE
// ======================================================

app.post('/api/save', async (req, res) => {

    const {
        userId,
        saveData
    } = req.body || {};

    if (!userId || !saveData) {

        return res.status(400).json({
            success: false,
            error: 'missing data'
        });
    }

    const id = String(userId)
        .slice(0, 255);

    const data =
        normalizeSaveData(saveData);

    const client =
        await pool.connect();

    try {

        await client.query(
            'BEGIN'
        );

        // ==================================================
        // СОХРАНЯЕМ ВСЮ ИГРУ
        // ==================================================

        await client.query(`
            INSERT INTO user_saves (
                user_id,
                save_data,
                updated_at
            )

            VALUES (
                $1,
                $2::jsonb,
                CURRENT_TIMESTAMP
            )

            ON CONFLICT (user_id)

            DO UPDATE SET

                save_data =
                    EXCLUDED.save_data,

                updated_at =
                    CURRENT_TIMESTAMP
        `, [
            id,
            JSON.stringify(data)
        ]);

        // ==================================================
        // ОБНОВЛЯЕМ ЛИДЕРБОРД
        // ==================================================

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

                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                CURRENT_TIMESTAMP

            )

            ON CONFLICT (user_id)

            DO UPDATE SET

                username =
                    EXCLUDED.username,

                avatar =
                    EXCLUDED.avatar,

                rebirths =
                    EXCLUDED.rebirths,

                energy =
                    EXCLUDED.energy,

                total_produced =
                    EXCLUDED.total_produced,

                city_level =
                    EXCLUDED.city_level,

                updated_at =
                    CURRENT_TIMESTAMP
        `, [

            id,

            data.profile.name,

            data.profile.avatar,

            data.rebirths,

            data.energy,

            data.totalProduced,

            data.cityLevel
        ]);

        await client.query(
            'COMMIT'
        );

        res.json({

            success: true,

            updatedAt: Date.now()
        });

    } catch (error) {

        await client.query(
            'ROLLBACK'
        );

        console.error(
            'SAVE ERROR:',
            error
        );

        res.status(500).json({

            success: false,

            error: 'database save error'
        });

    } finally {

        client.release();
    }
});

// ======================================================
// LOAD
// ======================================================

app.get('/api/save/:id', async (req, res) => {

    try {

        const userId =
            String(req.params.id)
                .slice(0, 255);

        const result =
            await pool.query(`
                SELECT
                    save_data,
                    updated_at

                FROM user_saves

                WHERE user_id = $1
            `, [
                userId
            ]);

        if (result.rows.length === 0) {

            return res.json({

                success: true,

                data: null
            });
        }

        res.json({

            success: true,

            data:
                result.rows[0].save_data,

            updatedAt:
                result.rows[0].updated_at
        });

    } catch (error) {

        console.error(
            'LOAD ERROR:',
            error
        );

        res.status(500).json({

            success: false,

            error: 'database load error'
        });
    }
});

// ======================================================
// DELETE SAVE
// ======================================================

app.delete('/api/save/:id', async (req, res) => {

    try {

        const userId =
            String(req.params.id)
                .slice(0, 255);

        await pool.query(
            `
            DELETE FROM user_saves
            WHERE user_id = $1
            `,
            [userId]
        );

        await pool.query(
            `
            DELETE FROM leaderboard
            WHERE user_id = $1
            `,
            [userId]
        );

        res.json({

            success: true
        });

    } catch (error) {

        console.error(
            'DELETE ERROR:',
            error
        );

        res.status(500).json({

            success: false
        });
    }
});

// ======================================================
// LEADERBOARD
// ======================================================

app.get('/api/leaderboard', async (req, res) => {

    const sortMap = {

        rebirths:
            'rebirths',

        energy:
            'energy',

        total:
            'total_produced'
    };

    const sortColumn =
        sortMap[req.query.sort] ||
        'rebirths';

    try {

        const result =
            await pool.query(`
                SELECT

                    user_id,

                    username AS name,

                    avatar,

                    rebirths,

                    energy,

                    total_produced AS total,

                    city_level

                FROM leaderboard

                ORDER BY
                    ${sortColumn} DESC NULLS LAST,
                    updated_at ASC

                LIMIT 50
            `);

        res.json({

            success: true,

            data: result.rows
        });

    } catch (error) {

        console.error(
            'LEADERBOARD ERROR:',
            error
        );

        res.status(500).json({

            success: false
        });
    }
});

// ======================================================
// ИНФОРМАЦИЯ ОБ ИГРОКЕ
// ======================================================

app.get('/api/player/:id', async (req, res) => {

    try {

        const userId =
            String(req.params.id)
                .slice(0, 255);

        const result =
            await pool.query(`
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
            `, [
                userId
            ]);

        res.json({

            success: true,

            data:
                result.rows[0] || null
        });

    } catch (error) {

        console.error(
            'PLAYER ERROR:',
            error
        );

        res.status(500).json({

            success: false
        });
    }
});

// ======================================================
// START
// ======================================================

async function startServer() {

    await initDB();

    app.listen(
        PORT,
        () => {

            console.log(
                `Server started on port ${PORT}`
            );

            console.log(
                `http://localhost:${PORT}`
            );
        }
    );
}

startServer();
