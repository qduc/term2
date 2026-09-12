---
title: Keyboard Shortcuts
description: Complete reference of keyboard shortcuts in term2.
---

## Composer & Input Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Enter` | Composer (idle) | Submit prompt to model. |
| `Enter` | Composer (active turn) | Steer the active turn in real time at the next request boundary. |
| `Alt + Enter` / `Esc + Enter` | Composer (active turn) | Queue prompt to execute after the current turn completes. |
| `@` | Composer | Open interactive file / path completion menu. |
| `!` prefix | Composer (empty) | Enter direct shell mode. Prompt turns red (`! `). |
| `Backspace` | Composer (empty `!`) | Exit direct shell mode back to normal prompt. |
| `/` | Composer (start of line) | Open interactive slash commands menu. |
| `Ctrl + O` | Composer | Open interactive model picker menu. |
| `Ctrl + T` | Composer | Open reasoning effort selection menu. |
| `Ctrl + G` | Global / Composer | Toggle Background Task Manager. |
| `Shift + Tab` | Global / Composer | Toggle between Standard and Plan operating mode. |
| `Escape` | Composer (typing) | Clear composer text buffer. |
| `Double Escape` | Active Turn | Interrupt and cancel the active generation and tool execution. |
| `Up` / `Down` | Composer (empty) | Navigate input history (or queued messages if any are pending). |
| `Ctrl + C` | Global | Emergency exit with session usage summary. |

## Approval Prompt Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `y` | Tool Approval | Approve proposed action. |
| `n` | Tool Approval | Reject proposed action and prompt for optional reason (`Why? `). |
| `Escape` | Rejection Prompt | Cancel rejection reason prompt. |
| `Enter` | Rejection Prompt | Submit rejection reason to model. |

## Interactive Menu Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Up` / `Down` | Any Menu | Navigate menu list items. |
| `Enter` | Any Menu | Select highlighted item. |
| `Escape` | Any Menu | Close menu or go back to parent menu. |
| `Ctrl + R` | Model Menu | Refresh provider model catalog from API (bypass cache). |
| `Ctrl + F` | Model Menu | Toggle model as a favorite (`agent.favoriteModels`). |
| `Ctrl + N` | Model Menu (Favorites) | Assign a short nickname to the selected model (`agent.modelNicknames`). |
| `Ctrl + D` | Settings Menu | Reset highlighted setting to its default value. |

## Background Task Manager Shortcuts (`Ctrl+G`)

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Ctrl + G` or `Escape` | Task Manager | Close the task manager. |
| `Up` / `Down` | Task Manager | Navigate background and foreground tasks. |
| `Enter` | Task Manager | Inspect task details. |
| `b` + `Enter` | Task Manager (Foreground) | Move highlighted foreground task to background. |
| `x` + `Enter` | Task Manager (Background) | Request stop on highlighted background task. |

## Queue Editing Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Up` (on empty input) | Composer | Focus pending queued message list. |
| `e` or `Enter` | Queue Item | Pull selected queued item back into composer for editing. |
| `d` | Queue Item | Delete / retract selected queued message. |
| `Escape` | Queue Item | Exit queue selection. |
