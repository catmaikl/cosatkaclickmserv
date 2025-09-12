import telebot
import sqlite3
import time
import random
import os
from datetime import datetime, timedelta
from telebot import types
from flask import Flask, request

# Инициализация Flask приложения
app = Flask(__name__)

# Конфигурация для Render
TOKEN = os.environ.get('BOT_TOKEN', 'YOUR_BOT_TOKEN_HERE')
PORT = int(os.environ.get('PORT', 5000))

# Автоматическое определение WEBHOOK_URL для Render
RENDER_EXTERNAL_HOSTNAME = os.environ.get('RENDER_EXTERNAL_HOSTNAME', '')
if RENDER_EXTERNAL_HOSTNAME:
    WEBHOOK_URL = f"https://{RENDER_EXTERNAL_HOSTNAME}"
else:
    WEBHOOK_URL = os.environ.get('WEBHOOK_URL', '')

bot = telebot.TeleBot(TOKEN)

# Инициализация базы данных
def init_db():
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            balance INTEGER DEFAULT 0,
            last_claim TEXT DEFAULT CURRENT_TIMESTAMP,
            miners INTEGER DEFAULT 0,
            total_earned INTEGER DEFAULT 0,
            click_power INTEGER DEFAULT 1,
            miner_speed INTEGER DEFAULT 1,
            offline_earnings INTEGER DEFAULT 1
        )
    ''')
    
    conn.commit()
    conn.close()
    print("База данных инициализирована")

# Регистрация пользователя
def register_user(user_id, username):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()
    
    cursor.execute('INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)', 
                  (user_id, username or 'Unknown'))
    
    conn.commit()
    conn.close()

# Получение данных пользователя
def get_user_data(user_id):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()
    
    cursor.execute('SELECT * FROM users WHERE user_id = ?', (user_id,))
    user_data = cursor.fetchone()
    
    conn.close()
    
    if user_data:
        return {
            'user_id': user_data[0],
            'username': user_data[1],
            'balance': user_data[2],
            'last_claim': user_data[3],
            'miners': user_data[4],
            'total_earned': user_data[5],
            'click_power': user_data[6],
            'miner_speed': user_data[7],
            'offline_earnings': user_data[8]
        }
    return None

# Обновление баланса
def update_balance(user_id, amount):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()
    
    cursor.execute('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?',
                  (amount, amount, user_id))
    
    conn.commit()
    conn.close()

# Покупка майнера
def buy_miner(user_id):
    user = get_user_data(user_id)
    if not user:
        return False, 0
        
    miner_cost = 100 * (user['miners'] + 1)
    
    if user['balance'] >= miner_cost:
        conn = sqlite3.connect('miner_game.db')
        cursor = conn.cursor()
        
        cursor.execute('UPDATE users SET balance = balance - ?, miners = miners + 1 WHERE user_id = ?',
                      (miner_cost, user_id))
        
        conn.commit()
        conn.close()
        return True, miner_cost
    return False, miner_cost

# Улучшение параметров
def upgrade_parameter(user_id, param_type):
    user = get_user_data(user_id)
    if not user:
        return False, 0
        
    current_level = user[param_type]
    upgrade_cost = 500 * current_level
    
    if user['balance'] >= upgrade_cost:
        conn = sqlite3.connect('miner_game.db')
        cursor = conn.cursor()
        
        cursor.execute(f'UPDATE users SET balance = balance - ?, {param_type} = {param_type} + 1 WHERE user_id = ?',
                      (upgrade_cost, user_id))
        
        conn.commit()
        conn.close()
        return True, upgrade_cost
    return False, upgrade_cost

# Расчет заработка за время отсутствия
def calculate_offline_earnings(user_id):
    user = get_user_data(user_id)
    if not user or not user['last_claim']:
        return 0
    
    try:
        last_claim = datetime.strptime(user['last_claim'], '%Y-%m-%d %H:%M:%S')
    except ValueError:
        last_claim = datetime.now() - timedelta(hours=1)
    except Exception as e:
        print(f"Ошибка при парсинге времени: {e}")
        last_claim = datetime.now() - timedelta(hours=1)
    
    now = datetime.now()
    time_diff = min((now - last_claim).total_seconds(), 86400)
    
    if time_diff <= 0:
        return 0
        
    base_earnings = user['miners'] * (time_diff / 60)
    total_earnings = base_earnings * (1 + user['offline_earnings'] * 0.5) * user['miner_speed']
    
    return int(total_earnings)

# Обновление времени последнего сбора
def update_last_claim(user_id):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()
    
    cursor.execute('UPDATE users SET last_claim = datetime("now") WHERE user_id = ?', (user_id,))
    
    conn.commit()
    conn.close()

# Главное меню
def main_menu():
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
    btn1 = types.KeyboardButton('💰 Баланс')
    btn2 = types.KeyboardButton('⛏️ Майнить')
    btn3 = types.KeyboardButton('🏪 Магазин')
    btn4 = types.KeyboardButton('📊 Статистика')
    btn5 = types.KeyboardButton('🎁 Забрать оффлайн-доход')
    markup.add(btn1, btn2, btn3, btn4, btn5)
    return markup

# Магазин
def shop_menu():
    markup = types.InlineKeyboardMarkup()
    markup.row(
        types.InlineKeyboardButton('🛒 Купить майнер', callback_data='buy_miner'),
        types.InlineKeyboardButton('⚡ Скорость', callback_data='upgrade_miner_speed')
    )
    markup.row(
        types.InlineKeyboardButton('💪 Сила клика', callback_data='upgrade_click_power'),
        types.InlineKeyboardButton('🌙 Оффлайн', callback_data='upgrade_offline_earnings')
    )
    markup.row(types.InlineKeyboardButton('🔙 Назад', callback_data='back_to_main'))
    return markup

# Обработчик команды /start
@bot.message_handler(commands=['start'])
def start_command(message):
    try:
        register_user(message.from_user.id, message.from_user.username)
        
        welcome_text = """
🚀 Добро пожаловать в *Ленивого майнера*! 🚀

Здесь ты можешь зарабатывать монеты, покупать майнеры и улучшать свои характеристики!

*Основные команды:*
💰 Баланс - Посмотреть свой баланс
⛏️ Майнить - Заработать монеты кликом
🏪 Магазин - Купить улучшения
📊 Статистика - Посмотреть прогресс
🎁 Забрать оффлайн-доход - Получить монеты за время отсутствия

*Начни майнить прямо сейчас!* ⛏️
        """
        
        bot.send_message(message.chat.id, welcome_text, parse_mode='Markdown', reply_markup=main_menu())
    except Exception as e:
        print(f"Ошибка в start_command: {e}")
        bot.send_message(message.chat.id, "Произошла ошибка при запуске. Попробуйте еще раз.")

# Обработчик текстовых сообщений
@bot.message_handler(func=lambda message: True)
def handle_messages(message):
    try:
        user_id = message.from_user.id
        
        register_user(user_id, message.from_user.username)
        user = get_user_data(user_id)
        
        if not user:
            bot.send_message(message.chat.id, "❌ Ошибка загрузки данных. Попробуйте /start")
            return
            
        if message.text == '💰 Баланс':
            offline_earnings = calculate_offline_earnings(user_id)
            balance_text = f"""
*Ваш баланс:* {user['balance']} 🪙

*Майнеров:* {user['miners']} ⛏️
*Оффлайн-доход:* {offline_earnings} 🪙
*Всего заработано:* {user['total_earned']} 🪙

Майнеры приносят доход даже когда вы оффлайн!
            """
            bot.send_message(message.chat.id, balance_text, parse_mode='Markdown')
            
        elif message.text == '⛏️ Майнить':
            reward = 10 * user['click_power']
            update_balance(user_id, reward)
            update_last_claim(user_id)
            user = get_user_data(user_id)
            bot.send_message(message.chat.id, f"⛏️ Вы заработали *{reward} монет*! Баланс: {user['balance']} 🪙", parse_mode='Markdown')
            
        elif message.text == '🏪 Магазин':
            shop_text = """
🏪 *Магазин улучшений*

*Доступные улучшения:*
• 🛒 Купить майнер (пассивный доход)
• ⚡ Скорость майнинга (увеличивает доход майнеров)
• 💪 Сила клика (увеличивает доход за клик)
• 🌙 Оффлайн-заработок (увеличивает оффлайн-доход)
            """
            bot.send_message(message.chat.id, shop_text, parse_mode='Markdown', reply_markup=shop_menu())
            
        elif message.text == '📊 Статистика':
            stats_text = f"""
*📊 Ваша статистика:*

*Баланс:* {user['balance']} 🪙
*Майнеров:* {user['miners']} ⛏️
*Всего заработано:* {user['total_earned']} 🪙

*Улучшения:*
⚡ Скорость майнинга: Уровень {user['miner_speed']}
💪 Сила клика: Уровень {user['click_power']}
🌙 Оффлайн-заработок: Уровень {user['offline_earnings']}
            """
            bot.send_message(message.chat.id, stats_text, parse_mode='Markdown')
            
        elif message.text == '🎁 Забрать оффлайн-доход':
            earnings = calculate_offline_earnings(user_id)
            if earnings > 0:
                update_balance(user_id, earnings)
                update_last_claim(user_id)
                user = get_user_data(user_id)
                bot.send_message(message.chat.id, f"🎁 Вы получили *{earnings} монет* за время отсутствия!\nНовый баланс: {user['balance']} 🪙", parse_mode='Markdown')
            else:
                bot.send_message(message.chat.id, "⏰ Вы не отсутствовали достаточно долго для оффлайн-дохода!")
                
    except Exception as e:
        print(f"Ошибка в handle_messages: {e}")
        bot.send_message(message.chat.id, "❌ Произошла ошибка. Попробуйте еще раз.")

# Обработчик callback-запросов
@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    try:
        user_id = call.from_user.id
        user = get_user_data(user_id)
        
        if not user:
            bot.answer_callback_query(call.id, "❌ Ошибка загрузки данных")
            return
            
        if call.data == 'buy_miner':
            success, cost = buy_miner(user_id)
            if success:
                bot.answer_callback_query(call.id, f"✅ Куплен майнер за {cost} монет!")
                user = get_user_data(user_id)
                bot.edit_message_text(f"🏪 *Магазин улучшений*\n✅ Майнер куплен успешно!\nБаланс: {user['balance']} 🪙", call.message.chat.id, call.message.message_id, parse_mode='Markdown', reply_markup=shop_menu())
            else:
                bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")
                
        elif call.data == 'upgrade_miner_speed':
            success, cost = upgrade_parameter(user_id, 'miner_speed')
            if success:
                bot.answer_callback_query(call.id, f"✅ Улучшение скорости куплено за {cost} монет!")
                user = get_user_data(user_id)
                bot.edit_message_text(f"🏪 *Магазин улучшений*\n✅ Скорость майнинга улучшена!\nУровень: {user['miner_speed']}\nБаланс: {user['balance']} 🪙", call.message.chat.id, call.message.message_id, parse_mode='Markdown', reply_markup=shop_menu())
            else:
                bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")
                
        elif call.data == 'upgrade_click_power':
            success, cost = upgrade_parameter(user_id, 'click_power')
            if success:
                bot.answer_callback_query(call.id, f"✅ Улучшение силы клика куплено за {cost} монет!")
                user = get_user_data(user_id)
                bot.edit_message_text(f"🏪 *Магазин улучшений*\n✅ Сила клика улучшена!\nУровень: {user['click_power']}\nБаланс: {user['balance']} 🪙", call.message.chat.id, call.message.message_id, parse_mode='Markdown', reply_markup=shop_menu())
            else:
                bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")
                
        elif call.data == 'upgrade_offline_earnings':
            success, cost = upgrade_parameter(user_id, 'offline_earnings')
            if success:
                bot.answer_callback_query(call.id, f"✅ Улучшение оффлайн-дохода куплено за {cost} монет!")
                user = get_user_data(user_id)
                bot.edit_message_text(f"🏪 *Магазин улучшений*\n✅ Оффлайн-доход улучшен!\nУровень: {user['offline_earnings']}\nБаланс: {user['balance']} 🪙", call.message.chat.id, call.message.message_id, parse_mode='Markdown', reply_markup=shop_menu())
            else:
                bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")
                
        elif call.data == 'back_to_main':
            bot.delete_message(call.message.chat.id, call.message.message_id)
            bot.send_message(call.message.chat.id, "Главное меню:", reply_markup=main_menu())
            
    except Exception as e:
        print(f"Ошибка в handle_callback: {e}")
        bot.answer_callback_query(call.id, "❌ Произошла ошибка")

# Webhook обработчики
@app.route('/')
def index():
    return "Бот 'Ленивый майнер' работает! 🚀"

@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return ''
    return 'Bad Request', 400

# Запуск приложения
if __name__ == '__main__':
    try:
        init_db()
        print("Бот 'Ленивый майнер' инициализирован...")
        
        # Настройка webhook только если URL доступен
        if WEBHOOK_URL:
            print(f"Webhook URL: {WEBHOOK_URL}")
            try:
                bot.remove_webhook()
                time.sleep(1)
                bot.set_webhook(url=f"{WEBHOOK_URL}/webhook")
                print(f"Webhook установлен: {WEBHOOK_URL}/webhook")
            except Exception as e:
                print(f"Ошибка при установке webhook: {e}")
                print("Продолжаем без webhook...")
        else:
            print("Webhook URL не доступен, используем прямое подключение")
            
        # Запуск Flask приложения
        print(f"Запуск сервера на порту {PORT}")
        app.run(host='0.0.0.0', port=PORT, debug=False)
        
    except Exception as e:
        print(f"Критическая ошибка при запуске: {e}")
