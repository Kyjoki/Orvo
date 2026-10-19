# Vercel Production и Preview

Действующий [Production](https://orvo-office.vercel.app) обновлён 19 октября 2026: deployment `dpl_8H2YwJ3RHsVT8zBnPB2HYWPePiKM`, target `production`, статус `READY`, код `1e88384`. Служебный immutable origin — `https://orvo-lqblt6riq-maksimcoj697-3405.vercel.app`. Домен закреплён за проектом как Production domain, без привязки к Preview-ветке. Экран входа общедоступен без Vercel SSO; сам офис доступен только владельцу по паролю и Google Authenticator.

Предыдущий изолированный Preview сохранён: `https://orvo-jzhfoc3xx-maksimcoj697-3405.vercel.app` (`dpl_GXbFja58a5fXLNG9tgw6fE1cqakG`). На момент его сборки UI был привязан к короткому адресу, поэтому старый UI может перенаправлять на Production. Глобальный `ORVO_PREVIEW_ORIGIN` снят: будущие Preview используют собственный immutable origin. Ресурсы и автоматизация двух окружений разделены.

По запросу владельца старый адрес `orvo-jh3adr8kj-maksimcoj697-3405.vercel.app` закрыт отдельным опубликованным WAF deny-правилом по точному hostname. После обновления вкладки с Vercel SSO проверен HTTP 403 вместо входа Orvo. Анонимные запросы сначала останавливаются Vercel Authentication (GET 302 на вход Vercel, POST 401). Блокировка обратима; deployment, базы и файлы не удалялись. Production domain и служебный immutable origin этим правилом не затронуты.

## Подтверждённая конфигурация

| Область | Настройка |
| --- | --- |
| Ветка подготовки | `codex/vercel-readiness` |
| Vercel | Проект `orvo`, ID `prj_9QjUU68PCCh8UpgApSxDMNcAfPlG` |
| Команда / план | `maksimcoj697-3405`, Hobby |
| База Production | Отдельная Neon Free `orvo-production-db`, Франкфурт (`fra1`), только Production |
| Файлы Production | Private Blob `orvo-production-files`, `fra1`, только Production |
| Копии Production | Отдельный private Blob `orvo-production-backups`; его токен отсутствует в веб-приложении |
| База / файлы Preview | Отдельные `orvo-preview-db` / private Blob `orvo-preview-files`, только Preview |
| Приложение | Node.js 24.x, Next.js 16.4.2, eve 0.80.1, Next-centered `withEve` |
| Сборка Vercel | `npm run build` → `next build`; интеграция формирует сервис приложения и eve runtime |
| Сборка self-host | `npm run build:local` → `eve build && next build` |
| Production | `READY`, постоянный `orvo-office.vercel.app`, отдельное GitHub Environment `orvo-production-operations` |

Владелец выбрал пустой облачный офис. Локальные БД, сотрудники, память, переписка и файлы не переносятся. Создание владельца не создаёт команду разработчиков: сотрудников внутри продукта владелец добавляет сам. Существующие локальные данные сохраняются.

Для Preview созданы новые серверные секреты. Ключ OpenAI перенесён в серверный secret с прямого согласия владельца; значения и источник файла не документируются. Подключение модели подтверждено отдельным живым запросом и завершённой задачей, описанными в [отчёте проверки Vercel](vercel-test-report.md). Никакие ключи не нужны в клиентском коде или `NEXT_PUBLIC_*`.

Пароль владельца сгенерирован и хранится локально в игнорируемом `.orvo/cloud/preview-owner.env`. Содержимое файла, email владельца, cookie и токены в документацию не включаются.

## История первого deployment

Первый запуск с `--target preview` Vercel фактически назначил Production. Чтобы исправить это, удалён именно `dpl_3uUBzrWNTkpbcQG8mkmEzXp84niu`. Проект, Neon и Blob сохранены. После этапа проверок владелец отдельно разрешил полноценный Production-выпуск, описанный выше.

## Переменные и origin

Необходимы `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ORVO_RUNTIME_SECRET`, `BLOB_READ_WRITE_TOKEN` и ключ выбранного поставщика (`OPENAI_API_KEY` либо `AI_GATEWAY_API_KEY`). DB/Blob подключены только к своему окружению. Production использует `BETTER_AUTH_URL=https://orvo-office.vercel.app`, `ORVO_REQUIRE_MFA=1`, `ORVO_TEST_MODE=0`, новые runtime/reconciler credentials и ключ архива. Совместимый `BETTER_AUTH_SECRET` сохранён для перенесённого TOTP; смена сломала бы его расшифровку. Перенос OpenAI-ключа в Production отдельно разрешён владельцем. Он не передаётся GitHub Actions.

## Проверки первого Production-выпуска

- В отдельную пустую базу восстановлена свежая зашифрованная копия Preview. Сверены 9 миграций, включённая MFA и совпадение отпечатка зашифрованной TOTP-записи. Сессии отозваны; исходные Preview-данные не изменялись. На момент переноса в личном офисе 0 агентов, задач и вложений.
- Перед переключением прошли 15 групп HTTP/конфигурационных проверок; после переключения — ещё 6 публичных: вход без Vercel SSO, реальный режим, запрет чужих данных и CSRF, 403 на всех шести WAF probe paths, закрытые ops/runtime/Queue. Пароль владельца принят с обязательным Google Authenticator.
- Один служебный wake пустого офиса отправлен в Queue региона `fra1` и принят consumer `/api/queues/runtime` с HTTP 200 в 14:20:11 UTC. Сотрудники, задачи и модельные запросы этим тестом не создавались. Это проверка транспорта/consumer, выполнение реальной модельной задачи в Production пока не проверено.
- [CI релизного кода](https://github.com/Kyjoki/Orvo/actions/runs/39268135609), [Production reconciler](https://github.com/Kyjoki/Orvo/actions/runs/39268278293) и [первая Production-копия с проверкой целостности](https://github.com/Kyjoki/Orvo/actions/runs/39268136518) завершились success. CI включает TypeScript, 73 теста и сборку без модельных ключей.
- Сканирование runtime error logs этого deployment за 14:03–14:23 UTC вернуло 0 записей. Это ограниченное окно наблюдения; внешний error tracking/оповещение о просроченной копии пока не подключены.

После восстановления проверка модели намеренно сбрасывается. Серверный ключ настроен, доступ к каталогу и наличие GPT-6 Luna подтверждены без генерации. После входа владелец нажимает «Проверить подключение» в настройках и создаёт своих сотрудников. Полный пользовательский сценарий с реальной моделью в Production этим выпуском не объявляется проверенным.

Для следующего релиза: подготовьте Production через `vercel deploy --prod --skip-domain`, проверьте именно его, затем `vercel promote <immutable-url>`. Обновите `ORVO_DEPLOYMENT_URL` в `orvo-production-operations` на новый immutable URL и проверьте reconciler. Не удаляйте прежний deployment с активными runtime-выполнениями. Изменения данных не откатываются переключением домена; DB restore выполняется только в изолированные ресурсы по инструкции восстановления.

В Preview `appOrigin()` использует явно заданный точный HTTPS `ORVO_PREVIEW_ORIGIN`, иначе неизменяемый `https://VERCEL_URL`. `runtimeOrigin()` всегда использует текущий immutable deployment. Auth/CSRF доверяют только одному настроенному origin, а служебный вызов не уходит на Production или старую ветку. При заданном alias пользовательские страницы перенаправляются на него с сохранением пути и query; API, Queue и Eve продолжают работать на immutable origin. Произвольный branch alias автоматически не разрешается для входа.

Внутренний RPC посылает bearer Orvo и `x-vercel-trusted-oidc-idp-token` только текущему deployment origin. OIDC проходит front-door protection Vercel, bearer отдельно защищает данные и операции Orvo. Для окружений без OIDC предусмотрен серверный `VERCEL_AUTOMATION_BYPASS_SECRET`; его наличие не заявляется и он не заменяет собственную авторизацию приложения.

`ORVO_TEST_MODE=1` в Vercel запрещён. Локальные test fixtures не загружаются в Preview. Само сохранение ID модели не доказывает доступа; подключение подтверждает ограниченная проверка провайдера, которая может расходовать токены.

## Сборка и файлы deployment

`withEve` использует официальный Next-centered путь: Vercel собирает service graph из `next build`. Не заменяйте его self-host командой без проверки output интеграции. `npm run build:local` нужен для локального `next start`, использующего отдельный `.output` eve.

Доменные миграции PostgreSQL проходят в транзакции с `pg_advisory_xact_lock`; concurrent cold starts не должны одновременно применять одну миграцию. Next tracing API включает `migrations/*.sql`. Схему Better Auth и владельца подготавливают отдельными административными скриптами в доверенном окружении, а не открытым HTTP setup. До работы с ресурсом проверяют целевой Preview `DATABASE_URL`, без вывода строки подключения в лог.

`.vercelignore` использует allowlist исходников приложения: `src`, `agent`, `public`, `migrations` и явные build manifests/configs. `.orvo`, `.env*`, `.git`, локальные дампы и посторонние файлы рабочей папки не отправляются. Скрипты административного bootstrap запускают из доверенного checkout; они не становятся публичным API. Перед загрузкой проверяют фактический состав deployment, а не только Git ignore.

## Durable выполнение и оставшийся разрыв

На Vercel процессный interval из instrumentation отключён. Команды публикуют wake в закрытый Vercel Queue consumer, SQL leases согласуют доставку, а принятое задание исполняется eve/Workflow. Отдельный GitHub reconciler восстанавливает разрыв между commit и публикацией; опрос состояния для доставки не нужен. Подробности и ограничения — в [launch-hardening.md](launch-hardening.md).

Если первоначальная публикация сорвалась после фиксации БД, независимый `/ops/reconcile` повторно публикует pending outbox. Окружения GitHub для Production и Preview привязаны каждое к своему точному immutable URL; после релиза обновляют URL соответствующего окружения. `after()` не используется как облачный scheduler.

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
