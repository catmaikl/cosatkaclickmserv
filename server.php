<?php
$file = 'game_state.json';
$timeout = 3; // Удалять игрока через 3 секунды неактивности

// Получаем данные из GET-запроса
$id = $_GET['id'] ?? null;
$x  = $_GET['x']  ?? 0;
$y  = $_GET['y']  ?? 0;
$a  = $_GET['a']  ?? 0; // Угол (angle) от джойстика
$f  = $_GET['f']  ?? 0; // Факт выстрела (fire)

if (!$id) exit;

// Загружаем данные
$players = file_exists($file) ? json_decode(file_get_contents($file), true) : [];

// Обновляем текущего игрока
$players[$id] = [
    'x' => $x, 'y' => $y, 'a' => $a, 'f' => $f, 't' => time()
];

// Очистка старых игроков и подготовка ответа
$output = "";
foreach ($players as $pid => $data) {
    if (time() - $data['t'] > $timeout) {
        unset($players[$pid]);
        continue;
    }
    if ($pid != $id) {
        // Формат: id,x,y,угол,выстрел;
        $output .= "$pid,{$data['x']},{$data['y']},{$data['a']},{$data['f']};";
    }
}

file_put_contents($file, json_encode($players));
echo $output; // Отправляем строку обратно в Pocket Code