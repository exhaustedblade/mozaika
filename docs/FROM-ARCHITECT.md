# Что переносим из Architect

Architect (`~/Documents/ArchitectPlugin`) — ИИ-слой для AnyLogic. Его ценность не привязана к AnyLogic и почти целиком переносится.

| Что | Где сейчас | Как используем |
|---|---|---|
| Словарь MCP-инструментов (status, map, read, change, draw, build, run, watch, study, report…) | `src/com/architect/plugin/mcp/Tools.java` | тот же словарь поверх нового ядра (ARCHITECTURE.md) |
| Скрипты рисования сцены (перерисовка по имени и разнице) | плагин, how-to «drawing-script» | тот же подход для 2D/3D-сцены |
| Опыт проверки моделей: самопроверка, мутационная проверка, независимый пересчёт, анализ устойчивости | модель для ЦЭМИ: `~/Models/UzbekistanEcoTwin/report` (verify.py, robustness.py, Проверка_модели.pdf) | встроенная функция `verify` |
| Демо-модели как эталоны для Фазы 1 | `~/Models` (UzbekistanEcoTwin, NYC_EMS, Caspian, Mars, Titanic, Sheremetyevo) | пересобрать и сравнить; критерий готовности 0.1 |
| Знания о моделировании (how-to, правила, базы знаний) | `resources/kb/*.json` плагина | основа подсказок ИИ |
| Журналы ошибок (BUGS.md по демо) | `reports/session-*/**/BUGS.md` | список того, что в новой среде должно работать сразу |

**Правило:** Architect доводим до 1.0. Новые инструменты в нём проектируем так, чтобы они не зависели от AnyLogic. Тогда переход на «Мозаику» — это смена ядра, а не переписывание ИИ.
