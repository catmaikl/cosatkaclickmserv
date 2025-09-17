import telebot
from telebot import types
import random
import time
import sqlite3
import json
from datetime import datetime, timedelta

# Настройки бота
bot = telebot.TeleBot('YOUR_BOT_TOKEN_HERE')

# Инициализация базы данных
def init_db():
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()

    # Таблица пользователей
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (user_id INTEGER PRIMARY KEY, 
                  username TEXT,
                  coins INTEGER DEFAULT 0,
                  level INTEGER DEFAULT 1,
                  exp INTEGER DEFAULT 0,
                  energy INTEGER DEFAULT 100,
                  last_energy_update DATETIME,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP)''')

    # Таблица инвентаря
    c.execute('''CREATE TABLE IF NOT EXISTS inventory
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER,
                  item_id INTEGER,
                  quantity INTEGER DEFAULT 1,
                  FOREIGN KEY(user_id) REFERENCES users(user_id))''')

    # Таблица достижений
    c.execute('''CREATE TABLE IF NOT EXISTS achievements
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER,
                  achievement_id INTEGER,
                  unlocked DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY(user_id) REFERENCES users(user_id))''')

    conn.commit()
    conn.close()

# Класс для управления игровым состоянием
class GameState:
    def __init__(self):
        self.user_states = {}

    def set_state(self, user_id, state):
        self.user_states[user_id] = state

    def get_state(self, user_id):
        return self.user_states.get(user_id, 'main_menu')

game_state = GameState()

# Игровые константы
ITEMS = {
    1: {"name": "Рыбка", "price": 10, "energy": 20},
    2: {"name": "Молоко", "price": 5, "energy": 10},
    3: {"name": "Мячик", "price": 15, "fun": 20},
    4: {"name": "Когтеточка", "price": 50, "fun": 40},
    5: {"name": "Золотая рыбка", "price": 100, "energy": 50, "coins": 20}
}

ACHIEVEMENTS = {
    1: {"name": "Первые шаги", "description": "Начать игру"},
    2: {"name": "Богатый кот", "description": "Накопить 100 монет"},
    3: {"name": "Исследователь", "description": "Попробовать все активности"},
    4: {"name": "Гурман", "description": "Съесть 10 рыбок"}
}

MINIGAMES = {
    "hunt": {"name": "Охота", "energy_cost": 15, "min_coins": 5, "max_coins": 25, "exp": 10},
    "play": {"name": "Играть", "energy_cost": 10, "min_coins": 3, "max_coins": 15, "exp": 8},
    "sleep": {"name": "Сон", "energy_gain": 30, "time_required": 300}  # 5 минут
}

# Функции для работы с БД
def get_user_data(user_id):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    user = c.fetchone()
    conn.close()

    if user:
        return {
            "user_id": user[0],
            "username": user[1],
            "coins": user[2],
            "level": user[3],
            "exp": user[4],
            "energy": user[5],
            "last_energy_update": user[6]
        }
    return None

def create_user(user_id, username):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("INSERT INTO users (user_id, username, last_energy_update) VALUES (?, ?, ?)",
              (user_id, username, datetime.now()))
    conn.commit()
    conn.close()

def update_energy(user_id):
    user = get_user_data(user_id)
    if user and user['energy'] < 100:
        last_update = datetime.strptime(user['last_energy_update'], '%Y-%m-%d %H:%M:%S')
        now = datetime.now()
        time_diff = (now - last_update).seconds

        # Восстановление энергии: 1 энергия каждые 3 минуты
        energy_gain = min(time_diff // 180, 100 - user['energy'])

        if energy_gain > 0:
            conn = sqlite3.connect('kosatka_game.db')
            c = conn.cursor()
            c.execute("UPDATE users SET energy = energy + ?, last_energy_update = ? WHERE user_id = ?",
                      (energy_gain, now, user_id))
            conn.commit()
            conn.close()
            return energy_gain
    return 0

def add_coins(user_id, amount):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("UPDATE users SET coins = coins + ? WHERE user_id = ?", (amount, user_id))
    conn.commit()
    conn.close()

def add_exp(user_id, amount):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("UPDATE users SET exp = exp + ? WHERE user_id = ?", (amount, user_id))

    # Проверка уровня
    c.execute("SELECT level, exp FROM users WHERE user_id = ?", (user_id,))
    user = c.fetchone()
    exp_needed = user[0] * 100
    if user[1] >= exp_needed:
        c.execute("UPDATE users SET level = level + 1, exp = exp - ? WHERE user_id = ?",
                 (exp_needed, user_id))
        conn.commit()
        conn.close()
        return True  # Уровень повышен
    conn.close()
    return False

# Основные обработчики
@bot.message_handler(commands=['start'])
def start_game(message):
    user_id = message.from_user.id
    username = message.from_user.username

    if not get_user_data(user_id):
        create_user(user_id, username)
        unlock_achievement(user_id, 1)
        bot.send_message(message.chat.id, "🐱 Добро пожаловать в игру про Косатку!")

    show_main_menu(message.chat.id, user_id)

def show_main_menu(chat_id, user_id):
    update_energy(user_id)
    user = get_user_data(user_id)

    keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
    keyboard.row("🎮 Мини-игры", "🛍️ Магазин")
    keyboard.row("📊 Профиль", "🏆 Достижения")
    keyboard.row("🐱 Погладить Косатку")

    message = f"""🐱 *Косатка приветствует тебя!*

💎 Монеты: {user['coins']}
⚡ Энергия: {user['energy']}/100
📈 Уровень: {user['level']}
⭐ Опыт: {user['exp']}/{user['level'] * 100}

Выбери действие:"""

    bot.send_message(chat_id, message, parse_mode='Markdown', reply_markup=keyboard)
    game_state.set_state(user_id, 'main_menu')

@bot.message_handler(func=lambda message: message.text == "📊 Профиль")
def show_profile(message):
    user_id = message.from_user.id
    user = get_user_data(user_id)

    profile_text = f"""🐱 *Профиль Косатки*

👤 Игрок: @{user['username']}
💎 Монеты: {user['coins']}
⚡ Энергия: {user['energy']}/100
📈 Уровень: {user['level']}
⭐ Опыт: {user['exp']}/{user['level'] * 100}

Косатка - игривый котик, который любит:
• 🐭 Охотиться на мышей
• 🧶 Играть с клубком
• 😴 Спать на подоконнике"""

    bot.send_message(message.chat.id, profile_text, parse_mode='Markdown')

@bot.message_handler(func=lambda message: message.text == "🎮 Мини-игры")
def show_minigames(message):
    user_id = message.from_user.id
    user = get_user_data(user_id)

    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(types.InlineKeyboardButton("🐭 Охота (15⚡)", callback_data="game_hunt"))
    keyboard.add(types.InlineKeyboardButton("🧶 Играть (10⚡)", callback_data="game_play"))
    keyboard.add(types.InlineKeyboardButton("😴 Сон (5 мин)", callback_data="game_sleep"))
    keyboard.add(types.InlineKeyboardButton("🔙 Назад", callback_data="back_main"))

    bot.send_message(message.chat.id, "🎮 *Выбери мини-игру:*\n\nЭнергия: {}/100".format(user['energy']), 
                    parse_mode='Markdown', reply_markup=keyboard)

@bot.message_handler(func=lambda message: message.text == "🛍️ Магазин")
def show_shop(message):
    keyboard = types.InlineKeyboardMarkup()
    for item_id, item in ITEMS.items():
        btn_text = f"{item['name']} - {item['price']}💎"
        keyboard.add(types.InlineKeyboardButton(btn_text, callback_data=f"buy_{item_id}"))
    keyboard.add(types.InlineKeyboardButton("🔙 Назад", callback_data="back_main"))

    bot.send_message(message.chat.id, "🛍️ *Магазин для Косатки:*", parse_mode='Markdown', reply_markup=keyboard)

@bot.message_handler(func=lambda message: message.text == "🏆 Достижения")
def show_achievements(message):
    user_id = message.from_user.id
    achievements = get_user_achievements(user_id)

    achievements_text = "🏆 *Достижения:*\n\n"
    for ach_id, achievement in ACHIEVEMENTS.items():
        status = "✅" if ach_id in achievements else "❌"
        achievements_text += f"{status} *{achievement['name']}* - {achievement['description']}\n"

    bot.send_message(message.chat.id, achievements_text, parse_mode='Markdown')

@bot.message_handler(func=lambda message: message.text == "🐱 Погладить Косатку")
def pet_kosatka(message):
    responses = [
        "Косатка мурлычет от удовольствия! 🐱💕",
        "Мур-мур! Косатка трется о вашу руку! 😻",
        "Косатка переворачивается на спину, предлагая почесать животик! 🐾",
        "Мяу! Косатка благодарна за ласку! 🥰"
    ]
    bot.send_message(message.chat.id, random.choice(responses))

# Обработка callback-ов
@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    user_id = call.from_user.id
    user = get_user_data(user_id)

    if call.data == "back_main":
        show_main_menu(call.message.chat.id, user_id)
        bot.delete_message(call.message.chat.id, call.message.message_id)

    elif call.data.startswith("game_"):
        game_type = call.data.split("_")[1]
        play_minigame(call, game_type, user)

    elif call.data.startswith("buy_"):
        item_id = int(call.data.split("_")[1])
        buy_item(call, item_id, user)

def play_minigame(call, game_type, user):
    if game_type == "hunt":
        if user['energy'] >= MINIGAMES["hunt"]["energy_cost"]:
            # Симуляция охоты
            coins_earned = random.randint(MINIGAMES["hunt"]["min_coins"], MINIGAMES["hunt"]["max_coins"])
            add_coins(user_id, coins_earned)
            add_exp(user_id, MINIGAMES["hunt"]["exp"])
            update_energy_after_activity(user_id, MINIGAMES["hunt"]["energy_cost"])

            hunt_results = [
                "Косатка поймала мышь! 🐭",
                "Косатка охотится на птичек! 🐦",
                "Косатка гоняется за бабочкой! 🦋"
            ]

            bot.edit_message_text(f"{random.choice(hunt_results)}\n\n+{coins_earned}💎 | +{MINIGAMES['hunt']['exp']}⭐",
                                call.message.chat.id, call.message.message_id)
        else:
            bot.answer_callback_query(call.id, "❌ Недостаточно энергии!")

    elif game_type == "play":
        if user['energy'] >= MINIGAMES["play"]["energy_cost"]:
            coins_earned = random.randint(MINIGAMES["play"]["min_coins"], MINIGAMES["play"]["max_coins"])
            add_coins(user_id, coins_earned)
            add_exp(user_id, MINIGAMES["play"]["exp"])
            update_energy_after_activity(user_id, MINIGAMES["play"]["energy_cost"])

            play_results = [
                "Косатка играет с клубком ниток! 🧶",
                "Косатка бегает за лазерной указкой! 🔴",
                "Косатка прыгает за бумажным бантиком! 🎀"
            ]

            bot.edit_message_text(f"{random.choice(play_results)}\n\n+{coins_earned}💎 | +{MINIGAMES['play']['exp']}⭐",
                                call.message.chat.id, call.message.message_id)
        else:
            bot.answer_callback_query(call.id, "❌ Недостаточно энергии!")

    elif game_type == "sleep":
        bot.edit_message_text("😴 Косатка легла спать... Приходите через 5 минут!",
                            call.message.chat.id, call.message.message_id)
        # Здесь можно реализовать систему отслеживания времени сна

def buy_item(call, item_id, user):
    item = ITEMS[item_id]
    if user['coins'] >= item['price']:
        add_coins(user_id, -item['price'])
        add_to_inventory(user_id, item_id)

        if item_id in [1, 2, 5]:  # Еда
            update_energy_after_activity(user_id, -item.get('energy', 0))
            bot.edit_message_text(f"Косатка съела {item['name']}! Ням-ням! 🍽️",
                                call.message.chat.id, call.message.message_id)
        else:
            bot.edit_message_text(f"Вы купили {item['name']} для Косатки! 🎁",
                                call.message.chat.id, call.message.message_id)
    else:
        bot.answer_callback_query(call.id, "❌ Недостаточно монет!")

# Вспомогательные функции
def update_energy_after_activity(user_id, energy_cost):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("UPDATE users SET energy = energy - ? WHERE user_id = ?", (energy_cost, user_id))
    conn.commit()
    conn.close()

def add_to_inventory(user_id, item_id):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("INSERT INTO inventory (user_id, item_id) VALUES (?, ?)", (user_id, item_id))
    conn.commit()
    conn.close()

def get_user_achievements(user_id):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("SELECT achievement_id FROM achievements WHERE user_id = ?", (user_id,))
    achievements = [row[0] for row in c.fetchall()]
    conn.close()
    return achievements

def unlock_achievement(user_id, achievement_id):
    conn = sqlite3.connect('kosatka_game.db')
    c = conn.cursor()
    c.execute("INSERT INTO achievements (user_id, achievement_id) VALUES (?, ?)", 
              (user_id, achievement_id))
    conn.commit()
    conn.close()

# Запуск бота
if __name__ == "__main__":
    init_db()
    print("Бот Косатка запущен!")
    bot.infinity_polling()