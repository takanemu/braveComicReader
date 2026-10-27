use crate::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use uuid::Uuid;

const SAMPLE_SIZE: usize = 4 * 1024;

#[derive(Debug, Serialize)]
pub struct ArchiveIdentity {
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct Bookmark {
    pub id: String,
    pub archive_id: String,
    pub page_index: usize,
    pub page_name: String,
    pub created_at: String,
}

pub fn fingerprint_archive(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path).map_err(|error| AppError::Internal(error.to_string()))?;
    let file_size = file
        .metadata()
        .map_err(|error| AppError::Internal(error.to_string()))?
        .len();
    let head_length = file_size.min(SAMPLE_SIZE as u64) as usize;
    let tail_length = file_size.min(SAMPLE_SIZE as u64) as usize;
    let tail_start = file_size.saturating_sub(tail_length as u64);

    let mut head = vec![0; head_length];
    file.read_exact(&mut head)
        .map_err(|error| AppError::Internal(error.to_string()))?;

    let mut tail = vec![0; tail_length];
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|error| AppError::Internal(error.to_string()))?;
    file.read_exact(&mut tail)
        .map_err(|error| AppError::Internal(error.to_string()))?;

    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());
    hasher.update(&head);
    hasher.update(&tail);
    Ok(hasher.finalize().to_hex().to_string())
}

pub fn identify_archive(
    database_path: &Path,
    archive_path: &Path,
) -> Result<ArchiveIdentity, AppError> {
    let fingerprint = fingerprint_archive(archive_path)?;
    let path = archive_path.to_string_lossy().into_owned();
    let connection = open_database(database_path)?;
    let existing_id = connection
        .query_row(
            "SELECT id FROM archives WHERE fingerprint = ?1",
            params![fingerprint],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?;

    let id = if let Some(id) = existing_id {
        connection
            .execute(
                "UPDATE archives SET last_seen_path = ?1 WHERE id = ?2",
                params![path, id],
            )
            .map_err(database_error)?;
        id
    } else {
        let id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO archives (id, fingerprint, last_seen_path) VALUES (?1, ?2, ?3)",
                params![id, fingerprint, path],
            )
            .map_err(database_error)?;
        id
    };

    Ok(ArchiveIdentity { id })
}

pub fn add_bookmark(
    database_path: &Path,
    archive_id: &str,
    page_index: usize,
    page_name: &str,
) -> Result<Bookmark, AppError> {
    let id = Uuid::new_v4().to_string();
    let connection = open_database(database_path)?;
    connection
        .execute(
            "INSERT INTO bookmarks (id, archive_id, page_index, page_name) VALUES (?1, ?2, ?3, ?4)",
            params![id, archive_id, page_index, page_name],
        )
        .map_err(database_error)?;
    get_bookmark(&connection, &id)
}

pub fn list_bookmarks(database_path: &Path, archive_id: &str) -> Result<Vec<Bookmark>, AppError> {
    let connection = open_database(database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, archive_id, page_index, page_name, created_at
       FROM bookmarks WHERE archive_id = ?1 ORDER BY page_index, created_at",
        )
        .map_err(database_error)?;
    let rows = statement
        .query_map(params![archive_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                archive_id: row.get(1)?,
                page_index: row.get(2)?,
                page_name: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(database_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

pub fn delete_bookmark(database_path: &Path, bookmark_id: &str) -> Result<(), AppError> {
    let connection = open_database(database_path)?;
    let deleted = connection
        .execute("DELETE FROM bookmarks WHERE id = ?1", params![bookmark_id])
        .map_err(database_error)?;
    if deleted == 0 {
        return Err(AppError::Internal("Bookmark not found".into()));
    }
    Ok(())
}

fn get_bookmark(connection: &Connection, bookmark_id: &str) -> Result<Bookmark, AppError> {
    connection
        .query_row(
            "SELECT id, archive_id, page_index, page_name, created_at FROM bookmarks WHERE id = ?1",
            params![bookmark_id],
            |row| {
                Ok(Bookmark {
                    id: row.get(0)?,
                    archive_id: row.get(1)?,
                    page_index: row.get(2)?,
                    page_name: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(database_error)
}

fn open_database(path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| AppError::Internal(error.to_string()))?;
    }

    let connection = Connection::open(path).map_err(database_error)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
       CREATE TABLE IF NOT EXISTS archives (
         id TEXT PRIMARY KEY NOT NULL,
         fingerprint TEXT NOT NULL UNIQUE,
         last_seen_path TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS bookmarks (
         id TEXT PRIMARY KEY NOT NULL,
         archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
         page_index INTEGER NOT NULL CHECK (page_index >= 0),
         page_name TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         UNIQUE (archive_id, page_index)
       );
       CREATE INDEX IF NOT EXISTS bookmarks_archive_page_idx
         ON bookmarks (archive_id, page_index);",
        )
        .map_err(database_error)?;
    Ok(connection)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::Internal(format!("Bookmark database error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        add_bookmark, delete_bookmark, fingerprint_archive, identify_archive, list_bookmarks,
    };
    use std::fs;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn fingerprint_uses_size_and_first_and_last_four_kibibytes() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.cbz");
        let renamed = directory.path().join("renamed.cbz");
        let mut contents = vec![b'a'; 12 * 1024];
        fs::write(&first, &contents).unwrap();
        fs::write(&renamed, &contents).unwrap();
        assert_eq!(
            fingerprint_archive(&first).unwrap(),
            fingerprint_archive(&renamed).unwrap()
        );

        contents[6 * 1024] = b'b';
        fs::write(&renamed, &contents).unwrap();
        assert_eq!(
            fingerprint_archive(&first).unwrap(),
            fingerprint_archive(&renamed).unwrap()
        );

        contents[0] = b'c';
        fs::write(&renamed, &contents).unwrap();
        assert_ne!(
            fingerprint_archive(&first).unwrap(),
            fingerprint_archive(&renamed).unwrap()
        );

        contents[0] = b'a';
        contents[11 * 1024] = b'd';
        fs::write(&renamed, &contents).unwrap();
        assert_ne!(
            fingerprint_archive(&first).unwrap(),
            fingerprint_archive(&renamed).unwrap()
        );
    }

    #[test]
    fn small_files_include_overlapping_head_and_tail_samples() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("small.cbz");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"small archive").unwrap();

        let expected = blake3::hash(
            &[
                &(b"small archive".len() as u64).to_le_bytes()[..],
                b"small archive",
                b"small archive",
            ]
            .concat(),
        )
        .to_hex()
        .to_string();
        assert_eq!(fingerprint_archive(&path).unwrap(), expected);
    }

    #[test]
    fn archive_identity_and_bookmarks_persist_and_can_be_deleted() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("data/bookmarks.sqlite");
        let archive_path = directory.path().join("sample.cbz");
        let renamed_archive_path = directory.path().join("renamed.cbz");
        fs::write(&archive_path, b"archive content").unwrap();
        fs::write(&renamed_archive_path, b"archive content").unwrap();

        let first_identity = identify_archive(&database, &archive_path).unwrap();
        let second_identity = identify_archive(&database, &archive_path).unwrap();
        assert_eq!(first_identity.id, second_identity.id);
        let moved_identity = identify_archive(&database, &renamed_archive_path).unwrap();
        assert_eq!(first_identity.id, moved_identity.id);
        assert!(uuid::Uuid::parse_str(&first_identity.id).is_ok());

        let bookmark = add_bookmark(&database, &first_identity.id, 4, "page-5.png").unwrap();
        assert_eq!(bookmark.page_index, 4);
        assert_eq!(
            list_bookmarks(&database, &first_identity.id).unwrap().len(),
            1
        );
        delete_bookmark(&database, &bookmark.id).unwrap();
        assert!(list_bookmarks(&database, &first_identity.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn duplicate_page_bookmarks_are_rejected() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("bookmarks.sqlite");
        let archive_path = directory.path().join("sample.cbz");
        fs::write(&archive_path, b"archive content").unwrap();
        let identity = identify_archive(&database, &archive_path).unwrap();
        add_bookmark(&database, &identity.id, 0, "page-1.png").unwrap();

        assert!(add_bookmark(&database, &identity.id, 0, "page-1.png").is_err());
    }
}
