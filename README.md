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
  Chaque instruction est donc bornée depuis l'intérieur des boucles `while` et `for`, et la
  session survit à une instruction interrompue. Une opération qui ne rend pas la main au
  langage n'est en revanche pas interrompue : `re.match('(a+)+$', 'a' * 30 + 'b')` peut rester
  bloqué indéfiniment malgré `--timeout 2`. Seuls `Ctrl+C` ou la fermeture du terminal en
  viennent à bout — c'est pour cela que `run`, qui est dans un *worker*, est la forme à
  privilégier pour un script douteux.
- Au `repl`, une instruction qui ouvre un bloc (`def`, `if`, …) se saisit jusqu'à la ligne
  vide, qui clôture et exécute la saisie.
- `--no-timeout` rend le terminal au script : `input()` fonctionne, mais plus rien n'est protégé.
- Un `--` sépare les options d'Uchi des arguments du script :
  `node ./bin/uchi.mjs run jeu.uchi -- --timeout` transmet `--timeout` au script.

## Erreurs d'épuisement

Allouer trop, s'appeler trop profondément ou agrandir une chaîne à l'excès échoue au niveau de
JavaScript. Ces échecs sont convertis en exceptions Uchi ordinaires, donc rattrapables :

```uchi
try:
    list(range(10**9))       # MemoryError : allocation impossible
except MemoryError:
    print('trop grand')

try:
    print(x)                 # RecursionError sur une structure trop imbriquée
except RecursionError:
    print('trop profond')
```

`RecursionError` dérive de `RuntimeError`, `MemoryError` de `Exception` — comme en Python. Une
vraie erreur du runtime (un `TypeError` de V8, par exemple) reste signalée comme telle et n'est
pas rattrapable : elle signale un défaut d'Uchi, pas une erreur du programme.

## Éditeur web

L'éditeur exécute du code avec les privilèges du processus. Trois mesures encadrent ce risque :

- `open()` est confiné au dossier de travail : un programme lancé depuis la page ne peut ni
  lire ni écrire ailleurs, et un lien symbolique posé dans le dossier ne contourne pas cette
  limite. `uchi run` n'est pas concerné — l'utilisateur choisit lui-même ses chemins.
- Les requêtes dont l'en-tête `Host` ne désigne pas la boucle locale sont refusées, ce qui
  bloque le *rebinding* DNS.
- Les requêtes d'écriture venant d'une autre origine sont refusées (`Origin`,
  `Sec-Fetch-Site`), et un `POST` doit déclarer `content-type: application/json`, ce qui
  soumet toute page distante à une vérification *preflight* que le serveur ne valide jamais.
  Ouvrir l'éditeur par un lien reste possible : les lectures ne sont pas concernées.

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
npm test           # 92 tests
npm run typecheck  # tsc --noEmit, mode strict
```

Couverture mesurée : **82,9 % des lignes**, 76,6 % des branches, 74,4 % des fonctions.

## État du projet

Version `0.1.0`, en développement actif. L'audit de code du 2026-09-29 a relevé des écarts
connus de conformité à Python — notamment la précision des entiers au-delà de 2⁵³, et des
arguments nommés acceptés puis ignorés par plusieurs fonctions de la bibliothèque standard
(`print(..., file=)`, `re.sub(..., count=)`, `enumerate(..., start=)`, `open(..., mode=)`).
La limite de profondeur d'appels ne couvre pas les rappels entre méthodes natives, mais leur
épuisement de pile est désormais un `RecursionError` rattrapable au lieu d'une erreur interne.
L'origine des requêtes de l'éditeur et l'accès aux fichiers du programme exécuté y sont encadrés
(voir « Éditeur web »), sans en faire une frontière de sécurité : **le serveur de l'éditeur ne
doit pas être exposé à un réseau** — il reste conçu pour un usage local sur la Loopback.

## Licence

MIT — déclarée dans `package.json`. Le fichier `LICENSE` n'a pas encore été ajouté.
