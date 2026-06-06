use crate::models::*;
use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
    inner: Arc<Mutex<Workspace>>,
}

impl Store {
    pub fn open() -> Result<Self> {
        let dir = dirs::data_dir()
            .context("could not resolve user data dir")?
            .join("Postie");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("workspace.json");

        let inner = if path.exists() {
            let raw = std::fs::read_to_string(&path)?;
            serde_json::from_str::<Workspace>(&raw).unwrap_or_default()
        } else {
            Workspace::default()
        };

        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        })
    }

    pub fn read<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Workspace) -> R,
    {
        let g = self.inner.lock().unwrap();
        f(&g)
    }

    pub fn write<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut Workspace) -> R,
    {
        let result = {
            let mut g = self.inner.lock().unwrap();
            f(&mut g)
        };
        self.persist()?;
        Ok(result)
    }

    fn persist(&self) -> Result<()> {
        let g = self.inner.lock().unwrap();
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*g)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
