import telebot
import sqlite3
import time
from telebot import types
from datetime import datetime, timedelta

# Замените на ваш токен бота
bot = telebot.TeleBot('8441483520:AAEGbAyEaRdNvjK61MqFFsj4b-YeqACVs98')

# Инициализация базы данных
def init_db():
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()

    # Таблица пользователей
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            balance INTEGER DEFAULT 0,
            last_claim TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            miners INTEGER DEFAULT 0,
            total_earned INTEGER DEFAULT 0
        )
    ''')

    # Таблица улучшений
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS upgrades (
            user_id INTEGER,
            upgrade_type TEXT,
            level INTEGER DEFAULT 1,
            FOREIGN KEY (user_id) REFERENCES users (user_id)
        )
    ''')

    conn.commit()
    conn.close()

# Регистрация пользователя
def register_user(user_id, username):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()

    cursor.execute('INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)', 
                  (user_id, username))

    # Добавляем базовые улучшения
    upgrades = ['miner_speed', 'click_power', 'offline_earnings']
    for upgrade in upgrades:
        cursor.execute('INSERT OR IGNORE INTO upgrades (user_id, upgrade_type) VALUES (?, ?)',
                      (user_id, upgrade))

    conn.commit()
    conn.close()

# Получение данных пользователя
def get_user_data(user_id):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()

    cursor.execute('SELECT * FROM users WHERE user_id = ?', (user_id,))
    user_data = cursor.fetchone()

    cursor.execute('SELECT * FROM upgrades WHERE user_id = ?', (user_id,))
    upgrades = cursor.fetchall()

    conn.close()

    if user_data:
        return {
            'user_id': user_data[0],
            'username': user_data[1],
            'balance': user_data[2],
            'last_claim': user_data[3],
            'miners': user_data[4],
            'total_earned': user_data[5],
            'upgrades': {upgrade[1]: upgrade[2] for upgrade in upgrades}
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
    miner_cost = 100 * (user['miners'] + 1)  # Стоимость растет с количеством

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
def upgrade_parameter(user_id, upgrade_type):
    user = get_user_data(user_id)
    current_level = user['upgrades'][upgrade_type]
    upgrade_cost = 500 * current_level  # Стоимость улучшения

    if user['balance'] >= upgrade_cost:
        conn = sqlite3.connect('miner_game.db')
        cursor = conn.cursor()

        cursor.execute('UPDATE users SET balance = balance - ? WHERE user_id = ?',
                      (upgrade_cost, user_id))

        cursor.execute('UPDATE upgrades SET level = level + 1 WHERE user_id = ? AND upgrade_type = ?',
                      (user_id, upgrade_type))

        conn.commit()
        conn.close()
        return True, upgrade_cost
    return False, upgrade_cost

# Расчет заработка за время отсутствия
def calculate_offline_earnings(user_id):
    user = get_user_data(user_id)
    last_claim = datetime.strptime(user['last_claim'], '%Y-%m-%d %H:%M:%S')
    now = datetime.now()

    # Максимальное время для оффлайн-заработка - 24 часа
    time_diff = min((now - last_claim).total_seconds(), 86400)

    # Базовый заработок: 1 монета в минуту за майнера
    base_earnings = user['miners'] * (time_diff / 60)

    # Умножаем на уровень улучшения оффлайн-заработка
    offline_multiplier = user['upgrades']['offline_earnings'] * 0.5
    total_earnings = base_earnings * (1 + offline_multiplier)

    return int(total_earnings)

# Обновление времени последнего сбора
def update_last_claim(user_id):
    conn = sqlite3.connect('miner_game.db')
    cursor = conn.cursor()

    cursor.execute('UPDATE users SET last_claim = CURRENT_TIMESTAMP WHERE user_id = ?', (user_id,))

    conn.commit()
    conn.close()

# Главное меню
def main_menu():
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.row('💰 Баланс', '⛏️ Майнить')
    markup.row('🏪 Магазин', '📊 Статистика')
    markup.row('🎁 Забрать оффлайн-доход')
    return markup

# Магазин
def shop_menu():
    markup = types.InlineKeyboardMarkup()
    markup.row(
        types.InlineKeyboardButton('🛒 Купить майнер', callback_data='buy_miner'),
        types.InlineKeyboardButton('⚡ Скорость майнинга', callback_data='upgrade_speed')
    )
    markup.row(
        types.InlineKeyboardButton('💪 Сила клика', callback_data='upgrade_power'),
        types.InlineKeyboardButton('🌙 Оффлайн-заработок', callback_data='upgrade_offline')
    )
    markup.row(types.InlineKeyboardButton('🔙 Назад', callback_data='back_to_main'))
    return markup

# Обработчик команды /start
@bot.message_handler(commands=['start'])
def start_command(message):
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

    bot.send_message(message.chat.id, welcome_text, 
                    parse_mode='Markdown', reply_markup=main_menu())

# Обработчик текстовых сообщений
@bot.message_handler(func=lambda message: True)
def handle_messages(message):
    user_id = message.from_user.id
    user = get_user_data(user_id)

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
        # Базовая награда за клик
        base_reward = 10
        click_power = user['upgrades']['click_power']
        reward = base_reward * click_power

        update_balance(user_id, reward)
        update_last_claim(user_id)

        bot.send_message(message.chat.id, 
                        f"⛏️ Вы заработали *{reward} монет*! Баланс: {user['balance'] + reward} 🪙",
                        parse_mode='Markdown')

    elif message.text == '🏪 Магазин':
        bot.send_message(message.chat.id, "🏪 *Магазин улучшений*", 
                        parse_mode='Markdown', reply_markup=shop_menu())

    elif message.text == '📊 Статистика':
        stats_text = f"""
*📊 Ваша статистика:*

*Баланс:* {user['balance']} 🪙
*Майнеров:* {user['miners']} ⛏️
*Всего заработано:* {user['total_earned']} 🪙

*Улучшения:*
⚡ Скорость майнинга: Уровень {user['upgrades']['miner_speed']}
💪 Сила клика: Уровень {user['upgrades']['click_power']}
🌙 Оффлайн-заработок: Уровень {user['upgrades']['offline_earnings']}
        """
        bot.send_message(message.chat.id, stats_text, parse_mode='Markdown')

    elif message.text == '🎁 Забрать оффлайн-доход':
        earnings = calculate_offline_earnings(user_id)
        if earnings > 0:
            update_balance(user_id, earnings)
            update_last_claim(user_id)
            bot.send_message(message.chat.id, 
                           f"🎁 Вы получили *{earnings} монет* за время отсутствия!",
                           parse_mode='Markdown')
        else:
            bot.send_message(message.chat.id, 
                           "⏰ Вы не отсутствовали достаточно долго для оффлайн-дохода!")

# Обработчик callback-запросов
@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    user_id = call.from_user.id
    user = get_user_data(user_id)

    if call.data == 'buy_miner':
        success, cost = buy_miner(user_id)
        if success:
            bot.answer_callback_query(call.id, f"✅ Куплен майнер за {cost} монет!")
            bot.edit_message_text("🏪 *Магазин улучшений*\n✅ Майнер куплен успешно!",
                                call.message.chat.id, call.message.message_id,
                                parse_mode='Markdown', reply_markup=shop_menu())
        else:
            bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")

    elif call.data.startswith('upgrade_'):
        upgrade_type = call.data.split('_')[1]
        success, cost = upgrade_parameter(user_id, f"{upgrade_type}_power" if upgrade_type == "click" else f"{upgrade_type}_earnings" if upgrade_type == "offline" else f"miner_{upgrade_type}")

        if success:
            bot.answer_callback_query(call.id, f"✅ Улучшение куплено за {cost} монет!")
            bot.edit_message_text("🏪 *Магазин улучшений*\n✅ Улучшение куплено успешно!",
                                call.message.chat.id, call.message.message_id,
                                parse_mode='Markdown', reply_markup=shop_menu())
        else:
            bot.answer_callback_query(call.id, f"❌ Недостаточно монет! Нужно: {cost}")

    elif call.data == 'back_to_main':
        bot.delete_message(call.message.chat.id, call.message.message_id)
        bot.send_message(call.message.chat.id, "Главное меню:", reply_markup=main_menu())

# Запуск бота
if __name__ == '__main__':
    init_db()
    print("Бот запущен...")
    bot.polling(none_stop=True)