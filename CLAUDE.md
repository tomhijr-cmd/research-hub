# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Research Hub — HRI Paper Feed

## Project Overview

This is a research hub for a PhD candidate in Human-Robot Interaction, focusing on non-humanoid social robots embedded in public spaces. Built on social psychology theories: priming, emotional contagion, and carry-over effect.

## What This App Does

- Fetches daily academic papers from Semantic Scholar API (free, no key needed)
- Displays papers as a clean feed with title, abstract, authors, date
- Shows a relevance score (1-5) based on user-defined keywords
- Keywords are managed by the user in a settings panel — never hardcoded
- All keywords and settings saved in localStorage

## Tech Stack

- Single file HTML + CSS + vanilla JavaScript
- No frameworks, no backend, no build tools
- Semantic Scholar Academic Graph API

## UI Preferences

- Clean, modern, academic-feeling design
- Dark or light mode toggle
- Mobile friendly
- Readable typography — this is for reading papers, not gaming

## Code Preferences

- Simple and readable over clever
- Well commented so non-developers can understand it
- localStorage for all persistence
