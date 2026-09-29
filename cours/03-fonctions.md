# Lecon 3 : fonctions

Code : [03-fonctions.uchi](03-fonctions.uchi)

```
npm run uchi -- run cours/03-fonctions.uchi
```

## A retenir

**Une fonction a un nom, des parametres, et rend une valeur.** `return` quitte
la fonction immediatement. Sans `return`, elle rend `None` : c'est different
de ne rien ecrire du tout, qui rend `None` aussi mais en plus silencieux.

**Un parametre avec une valeur par defaut** se passe en named pour etre
eclairci : `volume(2, hauteur=5)`. Apres l'etoile, les parametres sont
nommes seulement : c'est la seule facon de les donner, et l'ordre n'importe
plus. C'est la bonne maniere de rendre une option explicite.

**`*args` et `**kwargs`** gather le reste en tuple et en dictionnaire. On s'en
sert pour une fonction qui transmet (`resume(*args, **options)`), pas pour
contourner la clarte d'une signature : `def f(a, b)` vaut mieux que
`def f(*args)`.

**La portee locale est la norme.** Une variable creee dans une fonction meurt
avec elle. Pour toucher a une variable exterieure, il faut l'annoncer
(`global`), et c'est un signal d'alarme : le programme devient difficile a
tester. Pour un compteur, on prefere une closure avec `nonlocal`, ou une
classe.

**Une fonction est une valeur.** On la passe en argument, on la renvoie, on
la met dans une liste. C'est ce qui permet `sorted(..., key=len)`.

**La recursion a besoin d'un cas d'arret**, et Uchi limite la profondeur a
2000 appels : au-dela, `RecursionError`. Pour une taille de donnee inconnue,
une boucle est plus sure. Le nommage des cas de base fait la lisibilite :

```python
if n < 2:
    return n          # au lieu de "if n == 0 or n == 1"
```

## Pieges

L'etoile de definition (`def f(a, *, b)`) et l'etoile d'appel (`f(*args,
**kw)`) n'ont pas le meme role. La premiere rend un parametre obligatoire
nomme, la seconde decompose une liste ou un dictionnaire. Les deux
s'ecrivent `*`, leur sens depend de la position.

## Exercices

1. Ecrivez `est_pair(n)` qui rend `True` ou `False`, sans utiliser `%`.
2. Ecrivez `compte_mots(texte)` qui rend le nombre d'apparitions de chaque
   mot, en minuscules.
3. Ecrivez `aplatir(listes)` qui prend une liste de listes et rend une liste
   a plat, recursivement.

Les corrections sont en fin de `03-fonctions.uchi`.
