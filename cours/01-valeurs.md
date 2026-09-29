# Lecon 1 : valeurs, types et affichage

Code : [01-valeurs.uchi](01-valeurs.uchi)

```
npm run uchi -- run cours/01-valeurs.uchi
```

## A retenir

**Un nom lie une valeur.** Une variable n'est pas une boite qu'on copie, c'est
un nom qui designe une valeur. `b = a` donne a `b` le meme nom que `a`.

**Les types de base** sont ceux de Python : `int`, `float`, `str`, `bool`,
`None`, `list`, `tuple`, `dict`, `set`. `type(x)` dit lequel,
`isinstance(x, int)` demande « est-ce un int ? ».

**Le `/` donne toujours un float.** `7 / 2` vaut `3.5`, alors que `7 // 2` vaut
`3` et `7 % 2` vaut `1`. C'est la division entiere qui s'ecrit `//`.

**Une chaine vide est fausse.** `if texte:` suffit a savoir si `texte` contient
quelque chose : pas besoin de `if len(texte) > 0:`. Meme regle pour `0`, `0.0`,
`[]` et `{}`.

**Les f-strings** interpolent une expression dans un texte. `{x!r}` donne la
représentation avec guillemets, `{x:>10}` aligne, `{x:.2f}` arrondit,
`{x=}` écrit l'expression et sa valeur. `{nom!r:^20}` combine les trois.

**Convertir est explicite.** `int('42')` marche, `int('42.9')` non, exactement
comme en Python : `int` exige un entier ecrit en toutes lettres. Pour un
reel, il faut passer par `float`.

## Pieges

`copie = liste` ne copie pas la liste, les deux noms la designent. Deux noms
pointent sur la meme liste, donc `copie.append(...)` modifie `liste` aussi. Il
faut `.copy()`, `list(...)` ou une comprehension.

`print(nombres.sort())` affiche `None` : `sort` trie sur place et ne rend
rien. C'est `nombres = sorted(nombres)` qui rend une nouvelle liste.

## Exercices

1. Affichez un nom, un age et une taille moyenne sur une ligne, puis dans un
   tableau de trois colonnes alignees.
2. Convertissez `"  42  "` en entier, et dites si l'ordre de `.strip()` et
   `int()` change le resultat.
3. Ecrivez `etiquette(nom, score)` qui rend `"Ada: 8.5/10"`, et affichez-la
   avec une f-string.

Les corrections sont en fin de `01-valeurs.uchi`.
