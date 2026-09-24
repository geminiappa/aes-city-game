const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к PostgreSQL (Render предоставляет переменную DATABASE_URL автоматически)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных (создание таблицы при старте)
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_saves (
        user_id VARCHAR(255) PRIMARY KEY,
        save_data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('База данных успешно инициализирована.');
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
}
initDB();

// Получить сохранение пользователя
app.get('/api/save/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query('SELECT save_data FROM user_saves WHERE user_id = $1', [userId]);
    if (result.rows.length > 0) {
      res.json({ success: true, data: result.rows[0].save_data });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Сохранить прогресс пользователя
app.post('/api/save', async (req, res) => {
  const { userId, saveData } = req.body;
  if (!userId || !saveData) {
    return res.status(400).json({ success: false, error: 'Missing userId or saveData' });
  }

  try {
    await pool.query(`
      INSERT INTO user_saves (user_id, save_data, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) 
      DO UPDATE SET save_data = EXCLUDED.save_data, updated_at = CURRENT_TIMESTAMP;
    `, [userId, saveData]);
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка сохранения:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});