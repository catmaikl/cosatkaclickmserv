import os
from flask import Flask, render_template, request, session, redirect, url_for, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_login import LoginManager, UserMixin, login_user, login_required, current_user
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from datetime import datetime
import random
from string import ascii_uppercase
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['ALLOWED_EXTENSIONS'] = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif'}

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Создаем папку для загрузок, если ее нет
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


# Модели базы данных
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password = db.Column(db.String(100), nullable=False)
    friends = db.relationship('Friend', foreign_keys='Friend.user_id', backref='user', lazy=True)


class Friend(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    friend_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.String(20), default='pending')  # pending, accepted


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room = db.Column(db.String(50), nullable=False)
    sender = db.Column(db.String(100), nullable=False)
    content = db.Column(db.Text, nullable=False)
    is_file = db.Column(db.Boolean, default=False)
    filename = db.Column(db.String(100))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# Вспомогательные функции
def allowed_file(filename):
    return '.' in filename and \
        filename.rsplit('.', 1)[1].lower() in app.config['ALLOWED_EXTENSIONS']


def generate_room_code(length=6):
    return ''.join(random.choice(ascii_uppercase) for _ in range(length))


# Маршруты
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('chat'))
    return render_template('index.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('chat'))
        return render_template('login.html', error='Неверное имя пользователя или пароль')
    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        if User.query.filter_by(username=username).first():
            return render_template('register.html', error='Имя пользователя уже занято')
        hashed_password = generate_password_hash(password, method='pbkdf2:sha256')
        new_user = User(username=username, password=hashed_password)
        db.session.add(new_user)
        db.session.commit()
        return redirect(url_for('login'))
    return render_template('register.html')


@app.route('/chat')
@login_required
def chat():
    friends = Friend.query.filter(
        ((Friend.user_id == current_user.id) | (Friend.friend_id == current_user.id)) &
        (Friend.status == 'accepted')
    ).all()

    friend_list = []
    for friend in friends:
        if friend.user_id == current_user.id:
            friend_user = User.query.get(friend.friend_id)
        else:
            friend_user = User.query.get(friend.user_id)
        friend_list.append(friend_user)

    return render_template('chat.html', username=current_user.username, friends=friend_list)


@app.route('/uploads/<filename>')
@login_required
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)


@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return {'status': 'error', 'message': 'Файл не выбран'}

    file = request.files['file']
    if file.filename == '':
        return {'status': 'error', 'message': 'Файл не выбран'}

    if file and allowed_file(file.filename):
        filename = secure_filename(f"{current_user.username}_{datetime.now().timestamp()}_{file.filename}")
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        recipient = request.form['to']
        room = generate_room_code()

        # Сохраняем информацию о файле в базе
        new_msg = Message(
            room=room,
            sender=current_user.username,
            content=filename,
            is_file=True,
            filename=filename
        )
        db.session.add(new_msg)
        db.session.commit()

        return {'status': 'success', 'filename': filename}

    return {'status': 'error', 'message': 'Недопустимый тип файла'}


@app.route('/get_messages')
@login_required
def get_messages():
    friend = request.args.get('friend')
    if not friend:
        return []

    # Получаем все сообщения между текущим пользователем и другом
    messages = Message.query.filter(
        ((Message.sender == current_user.username) & (Message.recipient == friend)) |
        ((Message.sender == friend) & (Message.recipient == current_user.username))
    ).order_by(Message.timestamp.asc()).all()

    return [{
        'sender': msg.sender,
        'content': msg.content,
        'is_file': msg.is_file,
        'timestamp': msg.timestamp.isoformat()
    } for msg in messages]

# Обработчики Socket.IO
@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        join_room(current_user.username)
        emit('status', {'msg': f'{current_user.username} подключился'})


@socketio.on('private_message')
def handle_private_message(data):
    recipient = data['to']
    message = data['message']
    room = generate_room_code()

    # Сохраняем сообщение в базе
    new_msg = Message(
        room=room,
        sender=current_user.username,
        content=message,
        is_file=False
    )
    db.session.add(new_msg)
    db.session.commit()

    emit('new_message', {
        'from': current_user.username,
        'message': message,
        'is_file': False,
        'timestamp': datetime.utcnow().isoformat()
    }, room=recipient)


@socketio.on('file_upload')
def handle_file_upload(data):
    if 'file' not in request.files:
        return {'status': 'error', 'message': 'Файл не выбран'}

    file = request.files['file']
    if file.filename == '':
        return {'status': 'error', 'message': 'Файл не выбран'}

    if file and allowed_file(file.filename):
        filename = secure_filename(f"{current_user.username}_{datetime.now().timestamp()}_{file.filename}")
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        recipient = data['to']
        room = generate_room_code()

        # Сохраняем информацию о файле в базе
        new_msg = Message(
            room=room,
            sender=current_user.username,
            content=f"Файл: {filename}",
            is_file=True,
            filename=filename
        )
        db.session.add(new_msg)
        db.session.commit()

        emit('new_message', {
            'from': current_user.username,
            'message': filename,
            'is_file': True,
            'timestamp': datetime.utcnow().isoformat()
        }, room=recipient)

        return {'status': 'success', 'filename': filename}

    return {'status': 'error', 'message': 'Недопустимый тип файла'}


@socketio.on('add_friend')
def handle_add_friend(data):
    friend_username = data['username']
    friend = User.query.filter_by(username=friend_username).first()

    if not friend:
        emit('friend_status', {'status': 'error', 'message': 'Пользователь не найден'})
        return

    if friend.id == current_user.id:
        emit('friend_status', {'status': 'error', 'message': 'Нельзя добавить себя'})
        return

    existing_friend = Friend.query.filter(
        ((Friend.user_id == current_user.id) & (Friend.friend_id == friend.id)) |
        ((Friend.user_id == friend.id) & (Friend.friend_id == current_user.id))
    ).first()

    if existing_friend:
        if existing_friend.status == 'pending':
            if existing_friend.user_id == current_user.id:
                emit('friend_status', {'status': 'error', 'message': 'Запрос уже отправлен'})
            else:
                existing_friend.status = 'accepted'
                db.session.commit()
                emit('friend_status', {'status': 'success', 'message': 'Теперь вы друзья'}, room=current_user.username)
                emit('friend_status', {'status': 'info', 'message': f'{current_user.username} принял ваш запрос'},
                     room=friend.username)
        else:
            emit('friend_status', {'status': 'error', 'message': 'Уже друзья'})
    else:
        new_friend = Friend(user_id=current_user.id, friend_id=friend.id, status='pending')
        db.session.add(new_friend)
        db.session.commit()
        emit('friend_status', {'status': 'success', 'message': 'Запрос отправлен'}, room=current_user.username)
        emit('friend_status', {'status': 'info', 'message': f'{current_user.username} хочет добавить вас в друзья'},
             room=friend.username)


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, host="0.0.0.0", port=10000)
