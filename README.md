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
npm test           # 54 tests
npm run typecheck  # tsc --noEmit, mode strict
```

Couverture mesurée : **81,5 % des lignes**, 76,0 % des branches, 73,6 % des fonctions.

## État du projet

Version `0.1.0`, en développement actif. L'audit de code du 2026-09-29 a relevé des écarts
connus de conformité à Python — notamment la précision des entiers au-delà de 2⁵³, la
récursion qui échappe à la limite de profondeur, et l'absence de vérification d'origine sur
l'API de l'éditeur. **Le serveur de l'éditeur ne doit pas être exposé à un réseau** : il est
conçu pour un usage local sur la Loopback.

## Licence

MIT — déclarée dans `package.json`. Le fichier `LICENSE` n'a pas encore été ajouté.
