# Vercel Preview

Действующий [Preview](https://orvo-jh3adr8kj-maksimcoj697-3405.vercel.app) имеет статус Vercel `READY`: deployment `dpl_FWH2h9iopyAmdHr9UjtDWPyLQJj6`, target Preview. Cloud-сборки Next и eve прошли. Первоначальные сценарии перечислены ниже, новые 2FA/backup/Queue проверки — в [hardening-test-report.md](hardening-test-report.md). Подробный прогресс — в [progress.md](progress.md).

## Подтверждённая конфигурация

| Область | Настройка |
| --- | --- |
| Ветка подготовки | `codex/vercel-readiness` |
| Vercel | Проект `orvo`, ID `prj_9QjUU68PCCh8UpgApSxDMNcAfPlG` |
| Команда / план | `maksimcoj697-3405`, Hobby |
| База | Отдельная Neon Free `orvo-preview-db`, Франкфурт (`fra1`), подключена только к Preview |
| Файлы | Private Blob `orvo-preview-files`, `fra1`, подключён только к Preview |
| Приложение | Node.js 24.x, Next.js 16.4.2, eve 0.80.1, Next-centered `withEve` |
| Сборка Vercel | `npm run build` → `next build`; интеграция формирует сервис приложения и eve runtime |
| Сборка self-host | `npm run build:local` → `eve build && next build` |
| Production | Действующий deployment не оставлен; отдельные ресурсы не подготовлены |

Владелец выбрал пустой облачный офис. Локальные БД, сотрудники, память, переписка и файлы не переносятся. Создание владельца не создаёт команду разработчиков: сотрудников внутри продукта владелец добавляет сам. Существующие локальные данные сохраняются.

Для Preview созданы новые серверные секреты. Ключ OpenAI перенесён в серверный secret с прямого согласия владельца; значения и источник файла не документируются. Подключение модели подтверждено отдельным живым запросом и завершённой задачей, описанными в [отчёте проверки Vercel](vercel-test-report.md). Никакие ключи не нужны в клиентском коде или `NEXT_PUBLIC_*`.

Пароль владельца сгенерирован и хранится локально в игнорируемом `.orvo/cloud/preview-owner.env`. Содержимое файла, email владельца, cookie и токены в документацию не включаются.

## История первого deployment

Первый запуск с `--target preview` Vercel фактически назначил Production. Чтобы исправить это, удалён именно `dpl_3uUBzrWNTkpbcQG8mkmEzXp84niu`. Проект, Neon и Blob сохранены. Сейчас действующего Production не оставлено; нельзя описывать историю как «Production никогда не публиковался». Текущий адрес выше относится к отдельному проверяемому Preview.

## Переменные и origin

Необходимы `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ORVO_RUNTIME_SECRET`, `BLOB_READ_WRITE_TOKEN` и ключ выбранного поставщика (`OPENAI_API_KEY` либо `AI_GATEWAY_API_KEY`). Подключения БД/Blob ограничены Preview. У Production должны быть собственные данные и секреты перед отдельным выпуском; перенос Preview-секретов туда не предполагается.

В Preview `appOrigin()` и `runtimeOrigin()` берут точный неизменяемый `https://VERCEL_URL`. Поэтому auth/CSRF не доверяют всем `*.vercel.app`, а служебный вызов не уходит на Production или старую ветку. Переход на другой deployment-host означает другой origin; нельзя считать branch alias автоматически разрешённым origin входа.

Внутренний RPC посылает bearer Orvo и `x-vercel-trusted-oidc-idp-token` только текущему deployment origin. OIDC проходит front-door protection Vercel, bearer отдельно защищает данные и операции Orvo. Для окружений без OIDC предусмотрен серверный `VERCEL_AUTOMATION_BYPASS_SECRET`; его наличие не заявляется и он не заменяет собственную авторизацию приложения.

`ORVO_TEST_MODE=1` в Vercel запрещён. Локальные test fixtures не загружаются в Preview. Само сохранение ID модели не доказывает доступа; подключение подтверждает ограниченная проверка провайдера, которая может расходовать токены.

## Сборка и файлы deployment

`withEve` использует официальный Next-centered путь: Vercel собирает service graph из `next build`. Не заменяйте его self-host командой без проверки output интеграции. `npm run build:local` нужен для локального `next start`, использующего отдельный `.output` eve.

Доменные миграции PostgreSQL проходят в транзакции с `pg_advisory_xact_lock`; concurrent cold starts не должны одновременно применять одну миграцию. Next tracing API включает `migrations/*.sql`. Схему Better Auth и владельца подготавливают отдельными административными скриптами в доверенном окружении, а не открытым HTTP setup. До работы с ресурсом проверяют целевой Preview `DATABASE_URL`, без вывода строки подключения в лог.

`.vercelignore` использует allowlist исходников приложения: `src`, `agent`, `public`, `migrations` и явные build manifests/configs. `.orvo`, `.env*`, `.git`, локальные дампы и посторонние файлы рабочей папки не отправляются. Скрипты административного bootstrap запускают из доверенного checkout; они не становятся публичным API. Перед загрузкой проверяют фактический состав deployment, а не только Git ignore.

## Durable выполнение и оставшийся разрыв

На Vercel процессный interval из instrumentation отключён. Команды публикуют wake в закрытый Vercel Queue consumer, SQL leases согласуют доставку, а принятое задание исполняется eve/Workflow. Отдельный GitHub reconciler восстанавливает разрыв между commit и публикацией; опрос состояния для доставки не нужен. Подробности и ограничения — в [launch-hardening.md](launch-hardening.md).

Если первоначальная публикация сорвалась после фиксации БД, независимый `/ops/reconcile` повторно публикует pending outbox. Настроенный GitHub Environment привязан к точному Preview URL; после релиза URL обновляют отдельно. `after()` не используется как облачный scheduler.

Вместо Hobby Cron используется резервный GitHub schedule каждые пять минут. Это не постоянный worker и не SLA: расписания GitHub могут задерживаться. Обычная доставка использует Vercel Queues; платный план ради scheduler не подключался.

## Подтверждённые проверки

- Прошли 16 живых HTTP-проверок: вход владельца, cookies, авторизация, private Blob, CSP nonce/заголовки, runtime health и выход из сессии.
- Прошли пять реальных проверок Blob SDK. Они не заменяют полный сценарий загрузки через браузер.
- В браузере подтверждены вход и пустой офис: 0 сотрудников, без переноса локальных данных.
- Через браузерную форму задачи файл достиг состояния готовности без CSP-ошибок; снимок результата — `orvo-preview-file-ready.png` в материалах проверки.
- Реальная проверка модели учла 22 входных и 5 выходных токенов. Одна короткая задача GPT-6 Luna выполнилась примерно за 24,5 секунды: `ready_for_review` → `completed`, с положительным settled usage. Durable ID: `wrun_41M59VF7QY50QYPVN8JK2QK3FZ`. Это наблюдение одного запуска, не обещание времени ответа.
- Модельные обращения выполнены в ранее разрешённом бюджете $1, платных инфраструктурных ресурсов не подключали. Точные QA task/agent и один QA-файл удалены, численные лимиты восстановлены с CAS; выбранные OpenAI/GPT-6 Luna и результат проверки подключения оставлены владельцу. Финальный SQL подтвердил `agents=0`, `tasks=0`, `attachments=0`. В чистом браузере открыт `/office`: 0 агентов, модель настроена, состояние синхронизировано. Снимок — `orvo-cloud-ready.png`.
- Для Preview опубликовано бесплатное WAF deny-правило по точным путям `/.env`, `/.env.local`, `/.git/config`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin`. В браузере с Vercel SSO запрос `/.env` вернул 403 «This request was blocked». Неавторизованный raw-запрос ранее получал 302 на Vercel login перед WAF; это не свидетельство обхода защиты. Basic System Rules активны; платный OWASP managed ruleset не подключён.
- Локальные 56/56 тестов и TypeScript прошли. Эти результаты дополняют живую проверку, но не заменяют испытание аварийного восстановления.

## Оставшиеся проверки и ограничения

Первоначальная проверка Preview описана в [vercel-test-report.md](vercel-test-report.md); последующие 2FA, копии и очередь проверены отдельно в [hardening-test-report.md](hardening-test-report.md). Подключение TOTP владельцем остаётся обязательным ручным шагом. Новый Production требует отдельных ресурсов, секретов и финальной проверки.

Основа topology — установленные `node_modules/eve/docs/guides/frontend/nextjs.mdx` и `guides/deployment/vercel.mdx`. Платформенные ограничения сверяются с [Vercel Cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing); реализованные ограничения приложения — в [security.md](security.md).
