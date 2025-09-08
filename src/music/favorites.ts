// src/music/favorites.ts
import sqlite3 from 'sqlite3';
import path from 'path';

export interface FavoriteItem {
  id: number;
  title: string;
  url: string;
  artist?: string;
  addedBy: string;
  addedAt: string;
  playCount: number;
}

export class FavoritesManager {
  private db: sqlite3.Database;
  private dbPath: string;

  constructor() {
    this.dbPath = path.join(__dirname, '../../favorites.db');
    this.db = new sqlite3.Database(this.dbPath);
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        artist TEXT,
        addedBy TEXT NOT NULL,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        playCount INTEGER DEFAULT 0,
        UNIQUE(url, addedBy)
      )
    `;

    this.db.run(createTableSQL, (err) => {
      if (err) {
        console.error('Error creating favorites table:', err);
      } else {
        console.log('Favorites database initialized');
      }
    });
  }

  public async addFavorite(item: Omit<FavoriteItem, 'id' | 'addedAt' | 'playCount'>): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT OR REPLACE INTO favorites (title, url, artist, addedBy, playCount)
        VALUES (?, ?, ?, ?, COALESCE((SELECT playCount FROM favorites WHERE url = ? AND addedBy = ?), 0))
      `;
      
      this.db.run(sql, [item.title, item.url, item.artist, item.addedBy, item.url, item.addedBy], function(err) {
        if (err) {
          console.error('Error adding favorite:', err);
          reject(err);
        } else {
          console.log(`Added favorite: ${item.title} by ${item.addedBy}`);
          resolve(true);
        }
      });
    });
  }

  public async removeFavorite(url: string, addedBy: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const sql = 'DELETE FROM favorites WHERE url = ? AND addedBy = ?';
      
      this.db.run(sql, [url, addedBy], function(err) {
        if (err) {
          console.error('Error removing favorite:', err);
          reject(err);
        } else {
          console.log(`Removed favorite: ${url} by ${addedBy}`);
          resolve(this.changes > 0);
        }
      });
    });
  }

  public async getFavorites(addedBy?: string): Promise<FavoriteItem[]> {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM favorites';
      const params: any[] = [];
      
      if (addedBy) {
        sql += ' WHERE addedBy = ?';
        params.push(addedBy);
      }
      
      sql += ' ORDER BY addedAt DESC';
      
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('Error getting favorites:', err);
          reject(err);
        } else {
          resolve(rows as FavoriteItem[]);
        }
      });
    });
  }

  public async getFavoriteByUrl(url: string, addedBy: string): Promise<FavoriteItem | null> {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM favorites WHERE url = ? AND addedBy = ?';
      
      this.db.get(sql, [url, addedBy], (err, row) => {
        if (err) {
          console.error('Error getting favorite by URL:', err);
          reject(err);
        } else {
          resolve(row as FavoriteItem || null);
        }
      });
    });
  }

  public async incrementPlayCount(url: string, addedBy: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = 'UPDATE favorites SET playCount = playCount + 1 WHERE url = ? AND addedBy = ?';
      
      this.db.run(sql, [url, addedBy], (err) => {
        if (err) {
          console.error('Error incrementing play count:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public async getMostPlayed(addedBy?: string, limit: number = 10): Promise<FavoriteItem[]> {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM favorites';
      const params: any[] = [];
      
      if (addedBy) {
        sql += ' WHERE addedBy = ?';
        params.push(addedBy);
      }
      
      sql += ' ORDER BY playCount DESC, addedAt DESC LIMIT ?';
      params.push(limit);
      
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('Error getting most played favorites:', err);
          reject(err);
        } else {
          resolve(rows as FavoriteItem[]);
        }
      });
    });
  }

  public async searchFavorites(query: string, addedBy?: string): Promise<FavoriteItem[]> {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM favorites WHERE (title LIKE ? OR artist LIKE ?)';
      const params: any[] = [`%${query}%`, `%${query}%`];
      
      if (addedBy) {
        sql += ' AND addedBy = ?';
        params.push(addedBy);
      }
      
      sql += ' ORDER BY playCount DESC, addedAt DESC';
      
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('Error searching favorites:', err);
          reject(err);
        } else {
          resolve(rows as FavoriteItem[]);
        }
      });
    });
  }

  public async clearFavorites(addedBy: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const sql = 'DELETE FROM favorites WHERE addedBy = ?';
      
      this.db.run(sql, [addedBy], function(err) {
        if (err) {
          console.error('Error clearing favorites:', err);
          reject(err);
        } else {
          console.log(`Cleared all favorites for ${addedBy}`);
          resolve(true);
        }
      });
    });
  }

  public close(): void {
    this.db.close((err) => {
      if (err) {
        console.error('Error closing favorites database:', err);
      } else {
        console.log('Favorites database closed');
      }
    });
  }
}
