# Запуск, размещение и восстановление

Используйте Node.js 24.x и `npm ci`; major закреплён в `engines`. Текущая интеграция — Next.js 16.4.2 и eve 0.80.1, `withEve` из `eve/next`. После обновления перечитайте установленные `node_modules/eve/docs/guides/frontend/nextjs.mdx` и руководства `guides/deployment/`: сборка Vercel отличается от собственного Node-хоста.

## Переменные окружения

Имена ниже — интерфейс конфигурации, а не значения доступа. Секреты задаются в окружении нужного deployment или secret manager, без `NEXT_PUBLIC_`, Git, инструкций агентов и логов.

| Имя | Назначение |
| --- | --- |
| `DATABASE_URL` | PostgreSQL с TLS; Production и Preview используют отдельные Neon Free проекты |
| `BETTER_AUTH_SECRET` | Независимый случайный секрет сессий, минимум 32 символа |
| `ORVO_RUNTIME_SECRET` | Отдельный служебный bearer, минимум 32 символа |
| `BETTER_AUTH_URL` | Точный origin для собственного хоста/Production; Preview его игнорирует |
| `ORVO_PREVIEW_ORIGIN` | Необязательный точный HTTPS origin входа в Preview; без него используется `https://VERCEL_URL`. Production его игнорирует |
| `ORVO_RUNTIME_URL` | Origin Next API на собственном хосте; на Vercel используется текущий `VERCEL_URL` |
| `OPENAI_API_KEY` | Серверный ключ прямого OpenAI API |
| `AI_GATEWAY_API_KEY` | Серверный ключ, если выбран Vercel AI Gateway |
| `BLOB_READ_WRITE_TOKEN` | Серверный токен своего private Blob для Production или Preview; не выдаётся браузеру |
| `ORVO_FILE_STORAGE` | `blob` для выбора Blob на отдельном хосте; на Vercel Blob выбирается автоматически |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | Альтернативное S3-совместимое хранилище вне Vercel |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Серверный доступ альтернативного S3 bucket |
| `ORVO_OWNER_EMAIL`, `ORVO_OWNER_NAME`, `ORVO_OWNER_PASSWORD` | Однократный административный bootstrap владельца; пароль минимум 12 символов |
| `ORVO_TEST_MODE` | `1` только для localhost; на Vercel тестовый режим запрещён |
| `ORVO_TEST_DB_NAME`, `ORVO_TEST_DB_DIR` | Локальная PGlite внутри `.orvo/test-db/`, не облачная БД |
| `ORVO_WORKSPACE_ID` | Необязательный ID пространства |
| `EVE_NEXT_PRODUCTION_PORT`, `EVE_NEXT_PRODUCTION_ORIGIN` | Только собственная topology eve; не заменяют Vercel service graph |
| `EVE_PUBLIC_ROUTE_PREFIX` | Для отдельного размещения под префиксом; одинаково при сборке и запуске |
| `VERCEL_URL`, `VERCEL_ENV`, `VERCEL_OIDC_TOKEN` | Системное окружение Vercel; текущий host и доверенная служебная аутентификация |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Необязательный fallback для защиты front door; не заменяет bearer Orvo |

Полная карта ресурсов, действующий Production на `https://orvo-office.vercel.app`, история Preview и результаты проверок — [vercel-deployment.md](vercel-deployment.md). Production имеет собственные DB/Blob, ключи очереди и резервного архива. Его GitHub workflows используют закрытое окружение `orvo-production-operations`, доступное только ветке `main`.

## Первичная настройка

1. Подготовьте отдельную PostgreSQL и private Blob либо приватное S3-хранилище. Для действующих Production и Preview ресурсы уже созданы, повторно создавать их не требуется.
2. Задайте секреты только нужному окружению; отключите `ORVO_TEST_MODE` вне localhost.
3. В доверенном административном окружении выполните миграции домена и Better Auth, затем однократный `owner:create`. README содержит пример скрытого ввода пароля. Скрипты npm читают локальный `.env.local`; для cloud bootstrap используйте целевые переменные процесса и эквивалентный вызов `node --import tsx scripts/migrate.ts` / `scripts/create-owner.ts`, без копирования локальной БД.
4. Удалите bootstrap-пароль из рабочего окружения после создания владельца. Публичного initial-setup или регистрации нет.
5. Войдите, настройте профиль и модель, затем создайте сотрудников с нужными ролями. Облачный офис выбран пустым; 12 исторических разработчиков не добавляются автоматически. Существующие локальные данные сохраняются на месте.

Владелец действующего Preview уже создан; повторный bootstrap не требуется. Сгенерированный доступ находится только в локальном игнорируемом `.orvo/cloud/preview-owner.env`; email и пароль не переносятся в документацию, логи или отчёты.

Миграции домена PostgreSQL выполняются транзакционно с `pg_advisory_xact_lock`, чтобы согласовать одновременные cold starts. `next.config.ts` включает `migrations/*.sql` в tracing API. Это не заменяет предварительную проверку миграций на целевой БД; администратор также применяет схему Better Auth.

## Два пути сборки

| Среда | Команда | Результат |
| --- | --- | --- |
| Vercel, Next-centered `withEve` | `npm run build` | `next build`; интеграция формирует eve service graph и маршруты |
| Собственный Node-хост | `npm run build:local`, затем `npm start` | `eve build && next build`; Next запускает собранный `.output/server/index.mjs` eve |
| Локальная разработка | `npm run dev` | Next и eve dev через `withEve` |

Для self-hosting поставьте TLS reverse proxy перед `127.0.0.1` и процесс-менеджер. Не ограничивайте проксирование только `/eve/`: callback-маршруты Workflow также должны доходить до runtime согласно установленной интеграции. Если eve и Next находятся в разных контейнерах, `127.0.0.1` одного контейнера не адресует другой.

В eve 0.80.1 Local World использует `<cwd>/.eve/.workflow-data` даже при попытке переопределить `WORKFLOW_LOCAL_DATA_DIR`. Для разделения dev и локальной production нужны разные рабочие каталоги/тома. Не очищайте runtime state как build cache и не запускайте два независимых владельца одного каталога. Windows dev ранее выдавал `EPERM rename`; локальное продолжение проверялось на той же стабильной production-сборке, а не как исправление SDK. Local World не является хранилищем serverless-функции.

## Доставка команд и диагностика

На постоянном Node-хосте instrumentation доставляет pending outbox раз в 10 секунд. На Vercel процессный интервал отключён: команды публикуют wake в private Vercel Queue, а GitHub Actions восстанавливает пропущенную публикацию через защищённый `/ops/reconcile`. Чтение состояния в облаке не доставляет outbox. Уже принятый Workflow использует собственный durable runtime. Настройка, неопределённые исходы и ограничения расписаний описаны в [launch-hardening.md](launch-hardening.md).

Hobby Cron не используется для своевременного пробуждения Preview. Резервный scheduler — GitHub Actions каждые пять минут; возможны задержки платформы, гарантированного срока возобновления нет.

`/api/health` — liveness Next, не проверка PostgreSQL, Blob, Workflow или модели. `/eve/v1/health` также не заменяет прохождение задачи. У текущего READY Preview прошли cloud-сборки Next/eve, 16 живых HTTP-проверок, пять проверок Blob SDK, загрузка через форму задачи без CSP-ошибок и реальная короткая задача до `completed`. В браузере с Vercel SSO WAF вернул 403 на `/.env`; raw-запрос без SSO раньше перенаправлялся на Vercel login. Локально прошли 56/56 тестов и TypeScript. Подробности и финальная проверка чистого браузера — в [progress.md](progress.md).

## Резервирование и восстановление

Резервировать нужно SQL, закрытые объекты и совместимое состояние Workflow. Текстовые артефакты находятся в SQL, исходные вложения — в Blob/S3. Подключение Neon Free/private Blob само по себе не подтверждает настроенные backups, срок хранения или RPO/RTO.

1. Выберите доступный тарифу механизм PostgreSQL backup/restore и отдельную зашифрованную копию `pg_dump`; credentials передавайте защищённым способом, без пароля в shell-команде.
2. Для Preview реализован зашифрованный архив согласованного SQL snapshot и готовых private объектов. Скрипты, ежедневный workflow и проверка восстановления описаны в [launch-hardening.md](launch-hardening.md). Нативное версионирование Blob отдельно не заявляется.
3. Для Local World делайте согласованный snapshot при остановленном runtime; для Vercel Workflow проверяйте документированный механизм платформы, не копируйте временный диск функции.
4. Восстанавливайте в отдельном окружении с совместимым commit/схемой/runtime. Проверьте владельца, профили, память, артефакты, вложения и продолжение ожидающей задачи один раз.
5. Не отправляйте повторный вызов с неизвестным исходом вслепую: сначала проверьте сохранённые usage/reservations и состояние провайдера. Переключайте трафик после проверок и фиксируйте фактические RPO/RTO.

Локальная PGlite — только тестовый путь с отдельным IPC-процессом. CLI корректно закрывают соединение перед выходом; старые тестовые каталоги не переносятся в облако и не удаляются как часть размещения.

## CI и безопасность

Workflow GitHub Actions устанавливает зависимости, запускает typecheck, тесты и build без модельных ключей и платной генерации; это не release pipeline. Текущие результаты CI/аудита фиксируются в progress, не выводятся из наличия YAML. Модель и внешние ресурсы могут расходовать реальные квоты после подключения. [security.md](security.md) описывает реализованные границы и точные серверные лимиты.

Текущий аудит: три moderate предупреждения eve/just-bash/sprintf (`GHSA-hp3w-g68c-fv3c`), без high/critical; исправления без major downgrade нет, shell-инструменты отключены. Бесплатное WAF-правило на шесть точных путей опубликовано для Preview, 403 на `/.env` проверен через Vercel SSO. Платный OWASP managed ruleset не подключён. MFA реализована и обязательна в Preview; TOTP владельца подключается человеком. Production получает отдельные ресурсы и секреты. Платных инфраструктурных ресурсов не добавлено; модельные проверки выполнялись в ранее разрешённом бюджете $1.
