# Lecon 8 : classes

Code : [08-classes.uchi](08-classes.uchi)

```
npm run uchi -- run cours/08-classes.uchi
```

## A retenir

**Une classe est un type, un objet est une instance.** `__init__`prepare
l'objet : c'est la que l'on range les donnees, chaque objet a les siennes.
`self` designe l'objet courant, c'est le premier parametre de chaque methode.

**`__repr__` et `__str__` rendent un objet lisible.** Sans eux, `print`
affiche une adresse memoire. `__repr__` est la forme technique, `__str__` la
forme pour un lecteur ; `print` cherche `__str__` d'abord.

**Les crochets doubles permettent d'ecrire du code naturel.**
`__eq__` donne `==`, `__lt__` donne `<`, `__add__` donne `+`, `__len__` donne
`len()`, `__call__` rend l'objet appelable. C'est ce qui rend
`Temperature(10) + Temperature(5)` lisible.

**Un attribut de classe est partage, un attribut d'instance est propre.**
Ecrit dans le corps de la classe, l'attribut est commun a tous les objets ;
ecrit avec `self` dans `__init__`, il est propre a chacun.

**L'heritage reecrit et complete.** `class CompteEpargne(Compte)` reprend
tout de `Compte`, `super()` appelle la version de la classe mere. A utiliser
quand la relation est vraie : une epargne est un compte, un canine est un
animal. Pas pour « factoriser du code ».

`isinstance(x, Classe)` et `issubclass(A, B)` repondent a « est-ce de ce
type-la ? ».

## Pieges

Lire un attribut qui n'existe pas leve `AttributeError`, ce qui est utile :
une faute de frappe (`self.soldee` au lieu de `self.solde`) se voit
immediatement.

`super().__str__()` echoue si la classe mere n'a pas de `__str__`. C'est
rappel dans l'exercice 3.

`__init__` d'une exception personnelle ne fonctionne pas : Uchi leve
`AttributeError` sur `super().__init__()`. On passe le message a la levee,
`raise MonErreur('texte')`, comme a la lecon 5.

## Exercices

1. Ecrivez une classe `Rectangle` avec `aire()`, `perimetre()` et
   `__repr__`, et verifiez que deux rectangles sont independants.
2. Ecrivez une classe `Pile` avec `empiler`, `depiler` et `vide`, en levant
   `IndexError` sur une pile vide.
3. Ecrivez `CompteEpargne.__str__`, et expliquez pourquoi
   `super().__str__()` ne fonctionnerait pas ici.

Les corrections sont en fin de `08-classes.uchi`.
