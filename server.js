const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к БД PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= ИНИЦИАЛИЗАЦИЯ БД =================
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_saves(
                user_id VARCHAR(255) PRIMARY KEY,
                save_data JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard(
                user_id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255),
                rebirths BIGINT DEFAULT 0,
                energy NUMERIC DEFAULT 0,
                city_level INT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ ТАБЛИЦЫ (для решения ошибки column does not exist)
        await pool.query(`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS avatar VARCHAR(50) DEFAULT '👷';`);
        await pool.query(`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS total_produced NUMERIC DEFAULT 0;`);
        
        // Меняем тип колонки energy с BIGINT на NUMERIC для поддержки огромных чисел
        await pool.query(`ALTER TABLE leaderboard ALTER COLUMN energy TYPE NUMERIC USING energy::numeric;`);

        console.log("Database ready and schema updated");
    } catch(e) {
        console.error("Ошибка инициализации БД:", e);
    }
}
initDB();

// ================= СОХРАНЕНИЕ ПРОГРЕССА (SAVE) =================
app.post('/api/save', async (req, res) => {
    const { userId, saveData } = req.body;

    if (!userId || !saveData) {
        return res.status(400).json({ success: false, error: "missing data" });
    }

    try {
        await pool.query(`
            INSERT INTO user_saves (user_id, save_data)
            VALUES ($1, $2)
            ON CONFLICT (user_id)
            DO UPDATE SET save_data = $2, updated_at = CURRENT_TIMESTAMP
        `, [userId, saveData]);

        await pool.query(`
            INSERT INTO leaderboard (
                user_id, username, avatar, rebirths, energy, total_produced, city_level
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id)
            DO UPDATE SET
                username = $2,
                avatar = $3,
                rebirths = $4,
                energy = $5,
                total_produced = $6,
                city_level = $7,
                updated_at = CURRENT_TIMESTAMP
        `, [
            userId,
            saveData.profile?.name || "Оператор",
            saveData.profile?.avatar || "👷",
            saveData.rebirths || 0,
            saveData.energy || 0,
            saveData.totalProduced || 0,
            saveData.cityLevel || 0
        ]);

        res.json({ success: true });
    } catch(e) {
        console.error("Save error:", e);
        res.status(500).json({ success: false });
    }
});

// ================= ЗАГРУЗКА ПРОГРЕССА (LOAD) =================
app.get('/api/save/:id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT save_data FROM user_saves WHERE user_id = $1",
            [req.params.id]
        );

        if (result.rows.length) {
            res.json({ success: true, data: result.rows[0].save_data });
        } else {
            res.json({ success: true, data: null });
        }
    } catch(e) {
        console.error("Load error:", e);
        res.status(500).json({ success: false });
    }
});

// ================= ТАБЛИЦА ЛИДЕРОВ =================
app.get('/api/leaderboard', async (req, res) => {
    const { sort } = req.query; 
    
    let sortColumn = "rebirths";
    if (sort === "energy") sortColumn = "energy";
    if (sort === "total") sortColumn = "total_produced";

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
            ORDER BY ${sortColumn} DESC NULLS LAST
            LIMIT 50
        `);

        res.json({ success: true, data: result.rows });
    } catch(e) {
        console.error("Leaderboard error:", e);
        res.status(500).json({ success: false });
    }
});

// ================= ПОЗИЦИЯ ИГРОКА =================
app.get('/api/player/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM leaderboard WHERE user_id = $1
        `, [req.params.id]);

        res.json({ success: true, data: result.rows[0] || null });
    } catch(e) {
        console.error("Player data error:", e);
        res.status(500).json({ success: false });
    }
});

// ================= ЗАПУСК СЕРВЕРА =================
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
