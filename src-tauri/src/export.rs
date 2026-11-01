use serde::Deserialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportFile {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportBundle {
    pub name: String,
    pub files: Vec<ExportFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Folder,
    Zip,
}

fn safe_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let stem = segment.split('.').next().unwrap_or("").to_ascii_lowercase();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphanumeric() || b"_-".contains(&bytes[0]))
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
        && !segment.ends_with('.')
        && !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        && !(stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

impl ExportBundle {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.len() > 120 || !safe_segment(&self.name) {
            return Err("导出包名称必须是 1 至 120 位安全 ASCII 字符".into());
        }
        if self.files.is_empty() || self.files.len() > 10000 {
            return Err("导出包必须包含 1 至 10000 个文件".into());
        }
        let mut paths = HashSet::new();
        let mut bytes = 0usize;
        for file in &self.files {
            if file.path.len() > 240
                || !file.path.split('/').all(safe_segment)
                || !paths.insert(file.path.to_ascii_lowercase())
            {
                return Err(format!("导出文件路径无效或重复：{}", file.path));
            }
            bytes = bytes.checked_add(file.content.len()).ok_or("导出包过大")?;
            if file.content.len() > MAX_FILE_BYTES || bytes > MAX_BUNDLE_BYTES {
                return Err("导出文件超过 64 MiB 或导出包超过 256 MiB".into());
            }
        }
        for path in &paths {
            let mut parent = Path::new(path).parent();
            while let Some(directory) = parent {
                if paths.contains(&directory.to_string_lossy().replace('\\', "/")) {
                    return Err("导出文件与目录路径冲突".into());
                }
                parent = directory.parent();
            }
        }
        Ok(())
    }
}

pub fn write_folder(parent: &Path, bundle: &ExportBundle) -> Result<PathBuf, String> {
    bundle.validate()?;
    // Reserving a fresh directory prevents both overwrites and path races. On any
    // write failure TempDir removes only the directory created by this export.
    let output = tempfile::Builder::new()
        .prefix(&format!("{}-", bundle.name))
        .tempdir_in(parent)
        .map_err(|error| format!("无法创建导出文件夹：{error}"))?;
    for file in &bundle.files {
        let path = output.path().join(&file.path);
        fs::create_dir_all(path.parent().ok_or("导出路径无效")?)
            .map_err(|error| error.to_string())?;
        fs::write(&path, file.content.as_bytes())
            .map_err(|error| format!("无法写入导出文件：{error}"))?;
    }
    Ok(output.keep())
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ (0xedb88320u32.wrapping_mul(value & 1));
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

fn crc32(bytes: &[u8]) -> u32 {
    const TABLE: [u32; 256] = crc_table();
    let mut crc = u32::MAX;
    for byte in bytes {
        crc = (crc >> 8) ^ TABLE[((crc ^ u32::from(*byte)) & 0xff) as usize];
    }
    !crc
}

fn u16(output: &mut Vec<u8>, value: u16) {
    output.extend(value.to_le_bytes());
}
fn u32(output: &mut Vec<u8>, value: u32) {
    output.extend(value.to_le_bytes());
}

pub fn zip_bytes(bundle: &ExportBundle) -> Result<Vec<u8>, String> {
    bundle.validate()?;
    let mut output = Vec::new();
    let mut directory = Vec::new();
    for file in &bundle.files {
        let name = format!("{}/{}", bundle.name, file.path);
        let content = file.content.as_bytes();
        let crc = crc32(content);
        let offset = output.len() as u32;
        u32(&mut output, 0x04034b50);
        for value in [20, 0x0800, 0, 0, 0x0021] {
            u16(&mut output, value);
        }
        u32(&mut output, crc);
        u32(&mut output, content.len() as u32);
        u32(&mut output, content.len() as u32);
        u16(&mut output, name.len() as u16);
        u16(&mut output, 0);
        output.extend(name.as_bytes());
        output.extend(content);
        u32(&mut directory, 0x02014b50);
        for value in [20, 20, 0x0800, 0, 0, 0x0021] {
            u16(&mut directory, value);
        }
        u32(&mut directory, crc);
        u32(&mut directory, content.len() as u32);
        u32(&mut directory, content.len() as u32);
        for value in [name.len() as u16, 0, 0, 0, 0] {
            u16(&mut directory, value);
        }
        u32(&mut directory, 0);
        u32(&mut directory, offset);
        directory.extend(name.as_bytes());
    }
    let directory_offset = output.len() as u32;
    let directory_size = directory.len() as u32;
    output.extend(directory);
    u32(&mut output, 0x06054b50);
    u16(&mut output, 0);
    u16(&mut output, 0);
    u16(&mut output, bundle.files.len() as u16);
    u16(&mut output, bundle.files.len() as u16);
    u32(&mut output, directory_size);
    u32(&mut output, directory_offset);
    u16(&mut output, 0);
    Ok(output)
}

pub fn write_zip(path: &Path, bundle: &ExportBundle) -> Result<PathBuf, String> {
    crate::storage::atomic_write(path, &zip_bytes(bundle)?)?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> ExportBundle {
        ExportBundle {
            name: "say-clear-test".into(),
            files: vec![
                ExportFile {
                    path: "README.md".into(),
                    content: "说明".into(),
                },
                ExportFile {
                    path: "boards/stable-id/graph.json".into(),
                    content: "{}".into(),
                },
            ],
        }
    }

    #[test]
    fn folders_are_complete_and_never_overwrite_existing_exports() {
        let parent = tempfile::tempdir().unwrap();
        let first = write_folder(parent.path(), &bundle()).unwrap();
        let second = write_folder(parent.path(), &bundle()).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(first.join("README.md")).unwrap(), "说明");
        assert_eq!(
            fs::read_to_string(second.join("boards/stable-id/graph.json")).unwrap(),
            "{}"
        );
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 2);
    }

    #[test]
    fn invalid_paths_and_collisions_are_rejected_before_creating_output() {
        let parent = tempfile::tempdir().unwrap();
        for path in [
            "../escape.md",
            "/absolute.md",
            "C:/absolute.md",
            "boards\\escape.md",
            "a//b",
            "a/./b",
            "a/../b",
            "a/NUL.txt",
            "a/COM1",
            "a/trailing.",
            "a/汉字.md",
        ] {
            let mut data = bundle();
            data.files[0].path = path.into();
            assert!(write_folder(parent.path(), &data).is_err(), "{path}");
        }
        for path in ["readme.MD", "boards"] {
            let mut data = bundle();
            data.files.push(ExportFile {
                path: path.into(),
                content: String::new(),
            });
            assert!(write_folder(parent.path(), &data).is_err(), "{path}");
        }
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
    }

    #[test]
    fn zip_records_are_utf8_stored_with_valid_crc_and_directory_offsets() {
        let data = bundle();
        let bytes = zip_bytes(&data).unwrap();
        assert_eq!(&bytes[..4], &0x04034b50u32.to_le_bytes());
        assert_eq!(&bytes[6..8], &0x0800u16.to_le_bytes());
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        assert_eq!(&bytes[14..18], &crc32("说明".as_bytes()).to_le_bytes());
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], &0x06054b50u32.to_le_bytes());
        assert_eq!(
            u16::from_le_bytes(bytes[end + 10..end + 12].try_into().unwrap()),
            2
        );
        let offset = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
        assert_eq!(&bytes[offset..offset + 4], &0x02014b50u32.to_le_bytes());
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("export.zip");
        write_zip(&path, &data).unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn failed_exports_preserve_existing_files_and_reject_invalid_destinations() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("existing.zip");
        fs::write(&path, b"original").unwrap();
        let mut data = bundle();
        data.files[0].path = "../escape".into();
        assert!(write_zip(&path, &data).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert!(write_folder(&path, &bundle()).is_err());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
    }
}
