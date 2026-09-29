# Cours de depart

Huit lecons pour apprendre Uchi en ecrivant des programmes qui tournent
vraiment. Chaque lecon a deux fichiers :

- un fichier `.uchi` **executable**, qui est la lecon elle-meme : le code est
  commente, il s'execute d'un bout a l'autre, et les exercices sont proposes
  en fin de fichier avec leur correction ;
- une fiche `.md` qui reprend les points a retenir, les pieges classiques et
  l'enonce des exercices.

Les deux vont ensemble : on lit la fiche, on execute la lecon, on fait les
exercices.

## Lancer une lecon

Depuis la racine du projet :

```
npm run uchi -- run cours/01-valeurs.uchi
```

Les lecons 6 et 7 ecrivent des fichiers et importent un module voisin, donc
elles doivent etre lancees depuis le dossier `cours` :

```
cd cours
npm run uchi -- run 06-fichiers.uchi
```

Ou, depuis la racine, en une seule commande :

```
cd cours && npm run uchi -- run 06-fichiers.uchi
```

Chaque lecon affiche des resultats : si la derniere ligne n'est pas une
erreur, la lecon a tourne. Une lecon qui echoue s'arrete a la premiere erreur
et dit ou.

## Le programme

| # | Lecon | Ce qu'on apprend |
|---|-------|-----------------|
| 01 | [Valeurs, types et affichage](01-valeurs.md) | variables, types, conversions, f-strings, tri |
| 02 | [Conditions et boucles](02-conditions-boucles.md) | if/elif/else, while, for, break/continue, comprehensions |
| 03 | [Fonctions](03-fonctions.md) | parametres, portee, lambdas, recursion |
| 04 | [Listes et dictionnaires](04-collections.md) | collections, alias, ensembles, tuples |
| 05 | [Erreurs et exceptions](05-erreurs.md) | try/except/finally, raise, exceptions propres |
| 06 | [Fichiers](06-fichiers.md) | open, with, modes, parcours ligne a ligne |
| 07 | [Modules, JSON et texte](07-modules-json.md) | import, JSON, expressions regulieres |
| 08 | [Classes](08-classes.md) | attributs, methodes, heritage, operators |

L'ordre compte : chaque lecon reutilise ce que la precedente a montre. Le
module `outils.uchi` sert a la lecon 7.

## Conventions

- **Pas d'accent dans le code.** Les commentaires non plus. Un fichier Uchi
  reste lisible dans n'importe quel terminal, sur n'importe quelle
  machine. Pour ecrire un accent dans une chaine, on utilise un
  echappement : `'caf\u00e9'`, ou `chr(0x2603)`.
- **Quatre espaces** d'indentation, jamais des tabulations.
- **`#`** commence un commentaire ; une lignecommentee est un programme
  inchange, ce qui permet d'afficher un exercice et sa correction dans le
  meme fichier.
- Chaque lecon se lit de haut en bas et s'execute telle quelle : pas de
  `input()`, pas de fichier a preparer, pas de dependance.

## Exercices

Chaque lecon finit sur deux ou trois exercices, avec la correction
directement en dessous, en commentaire. Le plus simple est de lire la
correction, l'interessant est d'ecrire la reponse avant de la deployer.

## Differences avec Python

Uchi s'inspire de Python, ce qui rend la migration facile, mais quelques
points different. Ils sont signales dans les lecons quand ils apparaissent :

- pas de decorateurs (`@property`, `@staticmethod`) ;
- pas d'affectation par tranches (`liste[1:3] = [...]`) ;
- pas de lecture d'un `__doc__` ni de `%` pour formater ;
- les chemins relatifs partent du repertoire courant, pas du dossier du
  script ;
- un objet ne peut pas creer un attribut a la volee en dehors de sa classe
  sans que la lecture ensuite leve `AttributeError` ;
- un delai d'execution arrete les boucles du langage, pas une operation
  native comme une expression reguliere.

## Aller plus loin

- `examples/tournee.uchi` : un exemple unique qui montre beaucoup de
  syntaxe d'un coup.
- Le `README.md` a la racine decrit l'installation, l'editeur web et les
  delais d'execution.
