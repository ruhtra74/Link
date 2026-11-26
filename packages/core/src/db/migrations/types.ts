export interface Migration {
  /** Numéro croissant, sans trou. Correspond à `PRAGMA user_version` après application. */
  version: number;
  name: string;
  /** Une instruction SQL par élément (pas de fichier .sql : l'app mobile n'a pas de système de fichiers à ce stade). */
  statements: string[];
}
