# Демо-магазин SolanaPay-KZ

WordPress с WooCommerce в docker. Служит двум целям сразу: стенд для
разработки плагина и публичная демонстрация решения.

Адрес: https://shop.pagafox.kz

## Что внутри

- WordPress 7.1, PHP 8.3, Apache — контейнер `solanapaykz_shop`
- MariaDB 11 — контейнер `solanapaykz_shop_db`
- WooCommerce 11.1, валюта KZT, часовой пояс Asia/Almaty

Наружу WordPress смотрит только на `127.0.0.1:8080`; TLS и доступ снаружи
держит nginx на хосте (`/etc/nginx/sites-available/shop.pagafox.kz`).
Сертификат Let's Encrypt, продление автоматическое.

## Запуск и остановка

```bash
cd /var/www/solanapaykz/demo-shop
docker compose up -d      # поднять
docker compose ps         # состояние
docker compose logs -f    # логи
docker compose down       # остановить (данные сохраняются в томах)
```

## Разработка плагина

Каталог `plugin/` подключён внутрь контейнера как
`wp-content/plugins/solanapaykz`. Правки видны сразу, пересобирать образ
не нужно.

## WP-CLI

```bash
cd /var/www/solanapaykz/demo-shop
source .env
docker run --rm --network demo-shop_default --volumes-from solanapaykz_shop \
  -u 33:33 -e WORDPRESS_DB_HOST=db -e WORDPRESS_DB_NAME=wordpress \
  -e WORDPRESS_DB_USER=wordpress -e WORDPRESS_DB_PASSWORD="$MARIADB_PASSWORD" \
  wordpress:cli wp plugin list
```

Переменные окружения передавать обязательно: контейнер WP-CLI не наследует
их у работающего WordPress и по умолчанию ищет базу по адресу `mysql`.

## Секреты

`.env` (пароли базы) и `.admin-pass` (пароль администратора) лежат рядом с
`docker-compose.yml`, права 600, в git не попадают.

Пароли базы передаются переменными окружения, а не механизмом секретов
docker: тот монтирует файлы с правами хоста, и Apache внутри контейнера,
работающий от `www-data`, читать их не может — WordPress падает с ошибкой
подключения к базе.
