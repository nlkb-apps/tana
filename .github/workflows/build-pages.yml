name: Build game pages

on:
  schedule:
    - cron: "0 18 * * *"   # 03:00 JST daily
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: build-pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Generate pages
        env:
          SUPABASE_URL: ${{ vars.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ vars.SUPABASE_ANON_KEY }}
          SITE_URL: https://tana.gamingjapanese.com
        run: node scripts/build-pages.mjs

      - name: Commit changes
        run: |
          git config user.name "tana-pages[bot]"
          git config user.email "tana-pages@users.noreply.github.com"
          git add -A game platform sitemaps sitemap.xml robots.txt .nojekyll
          if git diff --cached --quiet; then
            echo "No page changes."
          else
            git commit -m "Rebuild game pages ($(date -u +%Y-%m-%d))"
            git push
          fi
