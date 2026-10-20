# Neal's brein

Een 3D-dashboard voor mijn second brain (Obsidian-vault in de privé-repo `nealharpal0/second-brain`).

- **De kaart:** elke wikipagina is een ster, gekleurd per gebied (Fluks, Kemeling, Pootjespret, YouTube, Studie, Ik, Second Brain). Lijnen zijn wikilinks. In het midden staat Claude.
- **Wat Claude deed:** uit `log.md`. Pagina's waar Claude de afgelopen week aan werkte gloeien, en er lopen lichtsporen van Claude naar die pagina's. Met *Speel de week af* zie je alle acties van de afgelopen zeven dagen achter elkaar. Ook zichtbaar: of er memo's in `inbox/` wachten en wanneer de volgende verwerkingsronde is (tijden uit `CLAUDE.md`).
- **Wat jij moet doen:** uit `Checklist.md`. Open acties met deadline, open vragen, en je volgorde uit `wiki/ik/prioriteiten-en-doelen.md`. De open acties draaien ook als ruitjes in een baan om de kaart, met een lijn naar de pagina waar ze bij horen (rood = te laat, geel = binnen 7 dagen, wit = later, grijs = geen datum, roze driehoek = vraag).

## Privacy

Deze repo en de GitHub Pages-site zijn openbaar, maar bevatten **alleen code**. De notities worden pas in de browser geladen, rechtstreeks uit de privé-repo via de GitHub API, met een token die alleen in die browser staat (`localStorage`). Zonder token toont de pagina niets van de vault.

- Gebruik een **fine-grained token** met alleen leesrecht op `second-brain` (Contents: Read-only).
- Geladen notities worden in dezelfde browser bewaard zodat de pagina daarna snel opent. *Token vergeten* (tandwiel rechtsboven) wist de token en die kopie.
- De pagina laadt niets van andere sites (geen CDN, geen Google Fonts); de Content-Security-Policy staat alleen verbindingen met `api.github.com` toe.

## Instellen

1. **Token maken:** github.com → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
   - Repository access: *Only select repositories* → `second-brain`
   - Permissions → Repository permissions → *Contents*: **Read-only**
   - Vervaldatum naar wens; daarna vraagt de pagina vanzelf om een nieuwe.
2. **Pagina openen:** https://nealharpal0.github.io/brain-dashboard/ en de token plakken. Doe dit op elk apparaat (Mac, iPhone) één keer.

## Hoe het werkt

| Bestand | Wat |
|---|---|
| `index.html`, `style.css` | Opbouw en vormgeving |
| `app.js` | Laadt de vault via de GitHub API, bouwt de panelen |
| `parse.js` | Leest frontmatter, wikilinks, `log.md`, `Checklist.md`, prioriteiten en inbox-tijden |
| `scene.js` | De 3D-scène (Three.js) |
| `vendor/` | Three.js r186 (MIT), lokaal meegeleverd |
| `fonts/` | Atkinson Hyperlegible en Cormorant Garamond (SIL OFL) |

De pagina ververst elke 2 minuten (alleen als er een nieuwe commit op `main` is) en bij terugkeren naar het tabblad. Wijzigingen verschijnen dus zodra de Obsidian-plugin Git ze heeft gepusht.

Het dashboard verwacht de conventies uit `CLAUDE.md` van de vault: `gebied:` in de frontmatter, logkoppen als `## [YYYY-MM-DD HH:MM] actie | titel`, en in `Checklist.md` de secties *Vragen voor jou*, *Openstaande acties* en *Afgerond*. Veranderen die, dan moet `parse.js` mee.

Lokaal bekijken: `python3 -m http.server` in deze map en open http://localhost:8000.
