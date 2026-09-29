# Lecon 4 : listes, dictionnaires, ensembles et tuples

Code : [04-collections.uchi](04-collections.uchi)

```
npm run uchi -- run cours/04-collections.uchi
```

## A retenir

**Choisir la structure, c'est la moitie du travail.**

| Besoin | Structure | Exemple |
|--------|-----------|---------|
| une suite ordonnee, modifiable | `list` | `[1, 2, 3]` |
| une suite figee | `tuple` | `(1, 2, 3)` |
| un nom vers une valeur | `dict` | `{'age': 20}` |
| savoir si on l'a deja vu | `set` | `{1, 2, 3}` |

Une liste de dictionnaires est le cas le plus courant en programmetique :

```python
lignes = [
    {'nom': 'Ada', 'age': 36},
    {'nom': 'Grace', 'age': 45},
]
```

**`sort` trie sur place et rend `None`.** `sorted` rend une nouvelle liste.
Ecrire `liste = sorted(liste)` quand on voulait `liste.sort()` est une faute
classique.

**Une tranche est un intervalle, fin exclue.** `x[1:3]`, `x[:2]`, `x[::-1]`
pour l'inverse. L'affectation par tranches (`x[1:3] = [...]`) n'est pas
supportee : on remplace les elements un par un, ou on reconstruit la liste.

**Un dictionnaire se parcourt avec `.items()`.** `for cle in d:` donne les
cles, `for cle, valeur in d.items():` donne les paires. `d.get(cle, defaut)`
evite une erreur quand la cle manque.

**Un ensemble ne garde ni ordre ni doublons.** Pour comparer deux groupes :
`union` (ou), `intersection` (et), `difference`, `symmetric_difference`, et
les tests `issubset`, `issuperset`, `isdisjoint`. Tous acceptent un ou
plusieurs operandes. On affiche un ensemble avec `sorted(...)` quand on veut
un ordre stable a l'ecran.

**Depaquetage** : `premier, second, *autres = [1, 2, 3]` et `a, b = b, a`.
C'est le moyen le plus court d'echanger deux valeurs ou de lire des paires.

## Le piege du cours : les alias

```python
original = [1, 2]
copie = original      # deux noms, une liste
copie.append(99)
print(original)       # [1, 2, 99]  : la liste a change
```

`copie` et `original` designent le meme objet. Pour une vraie copie :
`.copy()`, `list(...)`, ou une comprehension. Pour une liste de listes,
`[sous[:] for sous dans liste]` : la copie superficielle ne suffit pas.

## Exercices

1. Rendez un dictionnaire `{'pair': [...], 'impair': [...]}` a partir d'une
   liste de nombres, en un seul parcours.
2. Affichez les mots d'un texte par frequence decroissante, sans utiliser
   deux fois la meme liste.
3. Un ensemble n'a pas d'ordre, donc `pop` dessus n'est pas deterministe.
   Ecrivez une fonction qui rend un element de l'ensemble.

Les corrections sont en fin de `04-collections.uchi`.
