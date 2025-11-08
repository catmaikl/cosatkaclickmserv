import pygame

pygame.init()

W = 500
H = 500
scr = pygame.display.set_mode((W, H))

rect = pygame.rect.Rect(50, 50, 100, 100)

c = 0

# Создание шрифта
font = pygame.font.Font(None, 36)  # None - системный шрифт, 36 - размер

# Создание текстовой поверхности
text_surface = font.render(f"{c}", True, (255, 255, 255))  # Текст, сглаживание, цвет

run = True
while run:
    for e in pygame.event.get():
        if e.type == pygame.QUIT:
            run = False
        if e.type == pygame.KEYDOWN:
            if e.key == pygame.K_SPACE:
                c += 1

    scr.fill((255, 0, 225))  # Черный фон

    pygame.draw.rect(scr, (225, 0, 0), rect)

    text_surface = font.render(f"{c}", True, (255, 255, 255))

    scr.blit(text_surface, (50, 50))  # Отрисовка текста
    pygame.display.flip()

pygame.quit()