#!/usr/bin/env node
/**
 * Lanceur de l'interface en ligne de commande Uchi.
 *
 * Le type stripping de Node 24 permet d'executer directement les sources
 * TypeScript : ce fichier se contente donc de charger `src/cli.ts`.
 */

import { main } from '../src/cli.ts';

process.exitCode = main(process.argv.slice(2));
