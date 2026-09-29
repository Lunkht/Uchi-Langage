# Uchi

Un langage de programmation inspired de Python, avec un éditeur web intégré.

`.uchi` — un langage de scripts interpreted, sans aucune dépendance à l'exécution,
accompagné d'un éditeur qui s'ouvre dans le navigateur.

## Ce que le langage sait faire

- **Syntaxe Python** : fonctions, classes, héritage, `try` / `except` / `else` / `finally`,
  compréhensions, décorateurs d'opérateurs (`__add__`, `__lt__`, `__str__`…), `nonlocal`.
- **Précédence conforme à Python** : `2**3**2` vaut `512`, `-2**2` vaut `-4`,
  `1 << 2 + 1` vaut `8`.
- **Modules standards** : `math`, `re`, `json`, `string`, `sys`, `time`, `random`.
  Ni `os`, ni `shutil`, ni accès réseau : la surface d'API est volontairement étroite.
- **Fichiers** : `open` en lecture / écriture / ajout — seule primitive d'accès au disque.
- **Traces d'appels** : chaque exécution restitue la pile d'appels, dans la CLI comme dans l'éditeur.

## Installation

**Node.js ≥ 24 est requis** — l'interpréteur est écrit en TypeScript et exécuté tel quel par le
type-stripping natif de Node. Aucune étape de compilation.

```bash
git clone https://github.com/Lunkht/Uchi-Langage.git
cd Uchi-Langage
npm install          # TypeScript uniquement, en dépendance de développement
```

## Démarrage

```bash
node ./bin/uchi.mjs run examples/tournee.uchi   # exécute un script
node ./bin/uchi.mjs -e "print(6 * 7)"           # exécute un fragment
node ./bin/uchi.mjs repl                         # interpréteur interactif
node ./bin/uchi.mjs check script.uchi            # analyse sans exécuter
node ./bin/uchi.mjs gui . --port 8742            # éditeur web
```

L'éditeur s'ouvre sur `http://127.0.0.1:8742` : arborescence du dossier, coloration syntaxique,
exécution depuis le navigateur (`Ctrl+Entrée`), analyse sans exécution, diagnostics et traces
d'appels. Chaque exécution tourne dans un *worker* isolé, avec un délai maximal de 10 s par
défaut (`--timeout S`) : une boucle infinie immobilise le programme, jamais l'éditeur.

## Délais d'exécution

`run` et `repl` bornent eux aussi l'exécution, avec la même limite de 10 s :

```bash
node ./bin/uchi.mjs run lent.uchi --timeout 30   # 30 s au lieu de 10
node ./bin/uchi.mjs repl --timeout 2            # 2 s par instruction saisie
```

- `run` exécute le script dans un *worker* dédié. Le délai atteint, le programme est arrêté
  avec un `TimeoutError` ; le terminal, lui, ne peut pas se retrouver bloqué.
- `repl` ne peut pas employer de *worker* — la session perdrait son état entre les lignes.
  Chaque instruction est donc bornée depuis l'intérieur des boucles, et la session survit à
  une instruction interrompue. Une expression qui ne rend pas la main, comme une
  expression régulière maladroite, n'est en revanche pas interrompue.
- Au `repl`, une instruction qui ouvre un bloc (`def`, `if`, …) se saisit jusqu'à la ligne
  vide, qui clôture et exécute la saisie.
- `--no-timeout` rend le terminal au script : `input()` fonctionne, mais plus rien n'est protégé.
- Un `--` sépare les options d'Uchi des arguments du script :
  `node ./bin/uchi.mjs run jeu.uchi -- --timeout` transmet `--timeout` au script.

## Exemple

```uchi
def moyenne(values):
    if len(values) == 0:
        return 0
    total = 0
    for valeur in values:
        total += valeur
    return total / len(values)

print('moyenne :', moyenne([1, 2, 3, 4]))
print('carrés  :', [n * n for n in range(6) if n % 2 == 0])
```

`examples/tournee.uchi` fait le tour des fonctions, classes, exceptions, formatage,
expressions régulières et JSON.

## Développement

```bash
npm test           # 84 tests
npm run typecheck  # tsc --noEmit, mode strict
```

Couverture mesurée : **81,8 % des lignes**, 76,3 % des branches, 74,1 % des fonctions.

## État du projet

Version `0.1.0`, en développement actif. L'audit de code du 2026-09-29 a relevé des écarts
connus de conformité à Python — notamment la précision des entiers au-delà de 2⁵³, la
récursion qui échappe à la limite de profondeur, et l'absence de vérification d'origine sur
l'API de l'éditeur. **Le serveur de l'éditeur ne doit pas être exposé à un réseau** : il est
conçu pour un usage local sur la Loopback.

## Licence

MIT — déclarée dans `package.json`. Le fichier `LICENSE` n'a pas encore été ajouté.
