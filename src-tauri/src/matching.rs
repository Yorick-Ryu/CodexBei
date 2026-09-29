use crate::{
    config::Result,
    templates,
    versions::{self, Detector, Installation, Selection},
};
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct Service {
    detector: Detector,
    templates: templates::Service,
}

impl Service {
    pub fn new(directory: PathBuf) -> Result<Self> {
        Ok(Self {
            detector: Detector::default(),
            templates: templates::Service::new(directory)?,
        })
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.templates.client
    }

    pub fn targets(&self) -> Result<Vec<Installation>> {
        self.detector.targets()
    }

    pub fn current(&self) -> Result<Value> {
        let targets = self.targets()?;
        let template = self.templates.current(&versions::request(&targets))?;
        if templates::native_catalog(&template) && !versions::supports_native_catalog(&targets) {
            return Err("所选内核尚不支持原生模型目录，请重新选择版本。".into());
        }
        Ok(template)
    }

    pub async fn refresh(
        &mut self,
        selection: Option<Selection>,
        force: bool,
        activate: bool,
    ) -> Result<Value> {
        let selection_changed = self.detector.refresh(selection, force).await?;
        let targets = self.targets()?;
        let mut summary = self
            .templates
            .refresh(
                &versions::request(&targets),
                force || selection_changed,
                activate,
            )
            .await?;
        summary["installations"] = json!(self.detector.installations);
        summary["selection"] = json!(self.detector.selection);
        summary["modelClientVersion"] = json!(versions::client_version(&targets));
        Ok(summary)
    }
}
