import os
from flask import Flask, request
import telebot
from telebot.types import Update
import sqlite3
import random
import time
import json
from datetime import datetime, timedelta

# Настройки бота
BOT_TOKEN = os.environ.get('BOT_TOKEN', 'YOUR_BOT_TOKEN_HERE')
bot = telebot.TeleBot(BOT_TOKEN)
app = Flask(__name__)

# Инициализация базы данных
def init_db():
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (user_id INTEGER PRIMARY KEY, 
                  username TEXT,
                  coins INTEGER DEFAULT 0,
                  level INTEGER DEFAULT 1,
                  exp INTEGER DEFAULT 0,
                  energy INTEGER DEFAULT 100,
                  last_energy_update DATETIME,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS inventory
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER,
                  item_id INTEGER,
                  quantity INTEGER DEFAULT 1,
                  FOREIGN KEY(user_id) REFERENCES users(user_id))''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS achievements
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER,
                  achievement_id INTEGER,
                  unlocked DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY(user_id) REFERENCES users(user_id))''')
    
    conn.commit()
    conn.close()

# ... (ВСТАВЬТЕ СЮДА ВЕСЬ ВАШ ИГРОВОЙ КОД ИЗ ПРЕДЫДУЩЕГО ФАЙЛА) ...
# Включите все функции: GameState, ITEMS, ACHIEVEMENTS, MINIGAMES,
# get_user_data, create_user, update_energy, add_coins, add_exp,
# и все обработчики (@bot.message_handler и @bot.callback_query_handler)

# Webhook route
@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = Update.de_json(json_string)
        bot.process_new_updates([update])
        return ''
    return 'Bad request', 400

# Set webhook
@app.route('/set_webhook', methods=['GET'])
def set_webhook():
    # Получаем URL из переменных окружения Render
    render_url = os.environ.get('RENDER_EXTERNAL_URL')
    if render_url:
        webhook_url = f"{render_url}/webhook"
        bot.remove_webhook()
        time.sleep(1)
        result = bot.set_webhook(url=webhook_url)
        return f"Webhook set to {webhook_url}: {result}"
    return "RENDER_EXTERNAL_URL not set"

# Health check
@app.route('/')
def health_check():
    return "🐱 Косатка бот работает! Используйте /set_webhook для настройки"

if __name__ == "__main__":
    init_db()
    print("Бот Косатка запущен!")
    
    # Локально используем polling, на Render - webhook
    if os.environ.get('RENDER'):
        port = int(os.environ.get('PORT', 5000))
        app.run(host='0.0.0.0', port=port)
    else:
        # Для локальной разработки
        bot.remove_webhook()
        time.sleep(1)
        bot.infinity_polling()
