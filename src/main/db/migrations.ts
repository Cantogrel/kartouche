import type { DatabaseSync } from 'node:sqlite'

/** Migrations ordonnées ; l'index + 1 est la version de schéma (PRAGMA user_version). Ne jamais modifier une migration déjà livrée : en ajouter une. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // v2 : catalogue (DAT Libretro), état de synchro, quotas des fournisseurs, cache des fiches enrichies
  `CREATE TABLE catalog_games (
    id INTEGER PRIMARY KEY, console TEXT NOT NULL, title TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
    year INTEGER, genre TEXT, developer TEXT, crc TEXT, sha1 TEXT, size INTEGER, variant INTEGER NOT NULL DEFAULT 0,
    UNIQUE (console, title)
  );
  CREATE INDEX catalog_title ON catalog_games (title COLLATE NOCASE);
  CREATE INDEX catalog_crc ON catalog_games (crc);
  CREATE TABLE catalog_sync (console TEXT PRIMARY KEY, version TEXT, synced_at INTEGER NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE provider_usage (provider TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (provider, day));
  CREATE TABLE game_meta (game_id INTEGER NOT NULL, provider TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (game_id, provider))`,
  // v3 : score de popularité (IGDB) par jeu
  `ALTER TABLE catalog_games ADD COLUMN popularity REAL;
  CREATE INDEX catalog_popularity ON catalog_games (popularity)`,
  // v4 : regroupement des versions d'un même jeu (régions, révisions) ; dup = 1 pour les doublons, masqués par défaut
  `ALTER TABLE catalog_games ADD COLUMN base TEXT;
  ALTER TABLE catalog_games ADD COLUMN dup INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX catalog_base ON catalog_games (console, base)`,
  // v5 : img = identifiant d'image IGDB (Switch : catalogue issu d'IGDB) ; name = titre lisible (affichage, recherche, tri)
  `ALTER TABLE catalog_games ADD COLUMN img TEXT;
  ALTER TABLE catalog_games ADD COLUMN name TEXT;
  CREATE INDEX catalog_name ON catalog_games (name COLLATE NOCASE)`,
  // v6 : bibliothèque de l'utilisateur (ROMs importées ou scannées) ; game_id = jeu du catalogue reconnu, match = hash | name | none
  `CREATE TABLE library (
    id INTEGER PRIMARY KEY, game_id INTEGER, console TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL, crc TEXT, sha1 TEXT, match TEXT NOT NULL DEFAULT 'none', missing INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL, play_minutes INTEGER NOT NULL DEFAULT 0, last_played INTEGER
  );
  CREATE INDEX library_game ON library (game_id);
  CREATE INDEX library_crc ON library (console, crc)`,
  // v7 : émulateurs installés (ou indiqués à la main : custom = 1) ; dir = dossier d'installation, exe = chemin complet de l'exécutable
  `CREATE TABLE emulators (
    id TEXT PRIMARY KEY, version TEXT, dir TEXT NOT NULL, exe TEXT NOT NULL, custom INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL
  )`,
  // v8 : favoris et épingles (colonnes de la bibliothèque), collections nommées et leurs jeux
  `ALTER TABLE library ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE library ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at INTEGER NOT NULL);
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, library_id)
  );
  CREATE INDEX collection_items_lib ON collection_items (library_id)`,
  // v9 : succès (RetroAchievements) : liste des jeux par console (rapprochement par titre) et progression par jeu
  `CREATE TABLE ra_games (console TEXT NOT NULL, ra_id INTEGER NOT NULL, title TEXT NOT NULL, norm TEXT NOT NULL, PRIMARY KEY (console, ra_id));
  CREATE INDEX ra_games_norm ON ra_games (console, norm);
  CREATE TABLE ra_sync (console TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL);
  CREATE TABLE ra_progress (library_id INTEGER PRIMARY KEY REFERENCES library(id) ON DELETE CASCADE, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
  // v10 : un .cia 3DS doit être installé une fois dans le NAND virtuel d'Azahar avant de pouvoir être lancé
  `ALTER TABLE library ADD COLUMN cia_installed INTEGER NOT NULL DEFAULT 0`,
  // v11 : mises à jour/DLC Switch (identifiés par Title ID, ou par mot-clé + nom à défaut) rattachés au jeu de base
  // au lieu d'être une ligne à part ; title_id = Title ID du jeu (connu seulement quand son fichier le porte entre
  // crochets/parenthèses) ; celui de library_content est NULL pour un dump sans Title ID lisible (rattaché par nom)
  `ALTER TABLE library ADD COLUMN title_id TEXT;
  CREATE INDEX library_title_id ON library (console, title_id);
  CREATE TABLE library_content (
    id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title_id TEXT, version TEXT, label TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL, added_at INTEGER NOT NULL
  );
  CREATE INDEX library_content_lib ON library_content (library_id)`,
  // v12 : library_content.title_id doit être NULLABLE (mise à jour/DLC Switch sans Title ID lisible, rattaché par nom
  // — voir switchContent.ts) ; une base déjà en v11 l'a créée NOT NULL, et SQLite ne sait pas relâcher une contrainte
  // en place, d'où la reconstruction de la table (ses données existantes sont conservées).
  `CREATE TABLE library_content_v12 (
    id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title_id TEXT, version TEXT, label TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL, added_at INTEGER NOT NULL
  );
  INSERT INTO library_content_v12 SELECT * FROM library_content;
  DROP TABLE library_content;
  ALTER TABLE library_content_v12 RENAME TO library_content;
  CREATE INDEX library_content_lib ON library_content (library_id)`,
  // v13 : un .vpk Vita3K ne boote jamais tout seul après un install par chemin de contenu (constaté en vrai) ; on
  // installe une fois, on garde le Title ID annoncé par Vita3K, puis on relance toujours par ce Title ID (`-r`).
  `ALTER TABLE library ADD COLUMN vita_title_id TEXT`,
  // v14 : sources de téléchargement apportées par l'utilisateur (v0.2.0). Kartouche ne fournit, ne scrape ni n'agrège
  // aucune liste — chacune est une URL JSON ajoutée à la main dans Paramètres. list_id porte le cycle de vie (cascade
  // à la suppression d'une liste) ; ces deux tables ne doivent jamais être touchées par une resynchro du catalogue
  // (replaceConsole/pruneUnknownConsoles, catalogStore.ts) au même titre que `library`.
  `CREATE TABLE source_lists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, homepage TEXT, generated_at INTEGER,
    added_at INTEGER NOT NULL, last_refreshed_at INTEGER, entry_count INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES source_lists(id) ON DELETE CASCADE,
    game_id INTEGER REFERENCES catalog_games(id), console TEXT NOT NULL, title TEXT NOT NULL,
    size_bytes INTEGER, crc TEXT, sha1 TEXT, uris TEXT NOT NULL, note TEXT, matched INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sources_list ON sources (list_id);
  CREATE INDEX sources_game ON sources (game_id)`,
  // v14 : identifiant du jeu qui sert à retrouver ses sauvegardes (numéro de série, Title ID…), lu dans le jeu ou appris du journal de l'émulateur
  `ALTER TABLE library ADD COLUMN game_key TEXT`,
  // v15 : mises à jour/DLC de toutes les consoles qui en ont (Switch, 3DS, PS3, Wii U, Vita), plus seulement Switch. state = installé côté émulateur,
  // en attente (reason : onLaunch, needsKey, emulatorRunning…) ou en échec (nouvelle tentative possible) ; needs = clé fournie par l'utilisateur
  // dont l'installation dépend (licence, zRIF) ; source = d'où le fichier a été identifié (conteneur ou nom). library_orphans : mises à jour/DLC identifiés
  // dont le jeu parent n'est pas (encore) dans la bibliothèque — jamais un faux jeu : ils attendent, et sont rattachés dès que le jeu est importé.
  `ALTER TABLE library_content ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE library_content ADD COLUMN reason TEXT;
  ALTER TABLE library_content ADD COLUMN detail TEXT;
  ALTER TABLE library_content ADD COLUMN needs TEXT;
  ALTER TABLE library_content ADD COLUMN source TEXT NOT NULL DEFAULT 'container';
  ALTER TABLE library_content ADD COLUMN installed_at INTEGER;
  CREATE TABLE library_orphans (
    id INTEGER PRIMARY KEY, console TEXT NOT NULL, base_key TEXT NOT NULL, kind TEXT NOT NULL, title_id TEXT, version TEXT,
    label TEXT NOT NULL, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, needs TEXT, source TEXT NOT NULL, added_at INTEGER NOT NULL
  );
  CREATE INDEX library_orphans_key ON library_orphans (console, base_key)`,
  // v16 : fichiers que l'émulateur a créés dans son propre espace en installant ce contenu (JSON, chemins absolus) — la désinstallation retire exactement ceux-là, rien d'autre.
  `ALTER TABLE library_content ADD COLUMN emu_files TEXT`,
  // v17 : copie locale (dans <data>/sources/) d'une liste de sources ajoutée depuis un fichier : l'actualisation reste possible même si le fichier d'origine disparaît.
  `ALTER TABLE source_lists ADD COLUMN local_copy TEXT`,
  // v18 : fichiers de l'émulateur que l'installation d'un contenu a RÉÉCRITS (Vita3K fusionne une mise à jour dans le dossier du jeu) : copie de sauvegarde de chaque original (JSON
  // cible → copie), restaurée à la désinstallation. Sans elle, une mise à jour de ce genre ne pourrait pas être défaite.
  `ALTER TABLE library_content ADD COLUMN emu_backup TEXT`
]

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const current = row.user_version
  if (current > migrations.length) throw new Error(`Database schema v${current} is newer than this app (v${migrations.length})`)
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(migrations[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return migrations.length
}
